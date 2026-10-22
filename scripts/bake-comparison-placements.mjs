import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import RAPIER from '@dimforge/rapier3d-compat'
import { Quaternion, Vector3 } from 'three'
import { FreeReservePhysics, physicsReady } from '../src/scene/FreeReservePhysics.ts'
import { GOLD, STONE, STONES_PER_GOLD } from '../src/domain/reserve.ts'
import { SMALL_SCALE } from '../src/scene/reserveMotion.ts'
import { CONTAINER } from '../src/scene/containerConfig.ts'
import { connectedParts } from '../src/scene/collisionMesh.ts'
import { terrainSurface } from '../src/scene/terrainSurface.ts'
import { freePhysicsFixture, physicsAssetHashes } from './physics-fixture.mjs'

assert.equal(STONES_PER_GOLD, 200)
await physicsReady
const assets = await freePhysicsFixture()
const sourceAssets = await physicsAssetHashes()
const fullHulls = new WeakMap()
// This offline world can afford the entire convex surface. It must not freeze
// a decorative gold tip below the terrain merely because the runtime's cheaper
// directional hull omitted that vertex. The interactive physics stays unchanged.
class PlacementPhysics extends FreeReservePhysics {
  hull(shape) {
    const cached = fullHulls.get(shape)
    if (cached) return cached
    const probe = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic())
    const descriptor = RAPIER.ColliderDesc.convexHull(shape.vertices)
    assert.ok(descriptor, 'Exported model produces a complete convex hull')
    const collider = this.world.createCollider(descriptor.setDensity(2.4), probe)
    const vertices = new Float32Array(collider.vertices()), indices = new Uint32Array(collider.indices())
    let radius = 0, bottom = Infinity
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < vertices.length; i += 3) {
      radius = Math.max(radius, Math.hypot(vertices[i], vertices[i + 1], vertices[i + 2]))
      bottom = Math.min(bottom, vertices[i + 1])
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], vertices[i + axis])
        maximum[axis] = Math.max(maximum[axis], vertices[i + axis])
      }
    }
    const result = { vertices, indices, radius, bottom, thickness: Math.min(...maximum.map((value, i) => value - minimum[i])),
      mass: probe.mass(), center: probe.localCom(), inertia: probe.principalInertia(), frame: probe.principalInertiaLocalFrame() }
    this.world.removeRigidBody(probe)
    fullHulls.set(shape, result)
    return result
  }
}

function verifyVisualGeometry(pieces, boundary) {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 })
  const terrain = terrainSurface(assets.terrain)
  try {
    // Validate against the original visible surfaces, independently of the
    // simplified contact meshes used during settling.
    const statics = [assets.terrain, ...assets.obstacles.flatMap(connectedParts)].map(mesh =>
      world.createCollider(RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices)))
    const bodies = pieces.map(piece => {
      const vertices = Float32Array.from(assets[piece.kind].vertices, value => value * SMALL_SCALE)
      const q = new Quaternion(...piece.orientation), p = new Vector3(...piece.position)
      const collider = world.createCollider(RAPIER.ColliderDesc.convexHull(vertices)
        .setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }))
      const points = []
      for (let i = 0; i < vertices.length; i += 3) points.push(new Vector3(vertices[i], vertices[i + 1], vertices[i + 2]).applyQuaternion(q).add(p))
      return { collider, points }
    })
    let minimumWaterClearance = Infinity, minimumShoreClearance = Infinity, maximumTerrainPenetration = 0
    let maximumStaticPenetration = 0, maximumSupportGap = -Infinity, sampledVertices = 0
    for (const { collider, points } of bodies) {
      for (const point of points) {
        const surface = terrain.sample(point.x, point.z)
        assert.ok(surface, 'Every visible model vertex has actual terrain below its footprint')
        maximumTerrainPenetration = Math.max(maximumTerrainPenetration, surface.height - point.y)
        minimumWaterClearance = Math.min(minimumWaterClearance, point.y - CONTAINER.waterY)
        minimumShoreClearance = Math.min(minimumShoreClearance, boundary.clearance(point.x, point.z).distance)
        sampledVertices++
      }
      let supportGap = Infinity
      for (const other of [...statics, ...bodies.map(body => body.collider)]) {
        if (other === collider) continue
        const contact = other.contactCollider(collider, .04)
        if (!contact) continue
        if (statics.includes(other)) maximumStaticPenetration = Math.max(maximumStaticPenetration, -contact.distance)
        if (contact.normal1.y > .3) supportGap = Math.min(supportGap, contact.distance)
      }
      assert.ok(Number.isFinite(supportGap), 'Every frozen body has upward support from visible terrain, props or another saved body')
      maximumSupportGap = Math.max(maximumSupportGap, supportGap)
    }
    const result = { sampledVertices, minimumWaterClearance, minimumShoreClearance, maximumTerrainPenetration, maximumStaticPenetration, maximumSupportGap }
    assert.ok(maximumTerrainPenetration <= .008, JSON.stringify({ message: 'Visible mesh penetrates original terrain', ...result }))
    assert.ok(maximumStaticPenetration <= .008, JSON.stringify({ message: 'Visible convex hull penetrates a fixed original surface', ...result }))
    assert.ok(minimumWaterClearance >= 0, 'The entire visible model remains above water')
    assert.ok(minimumShoreClearance >= -.001, 'The entire visible model stays inside the dry shore')
    assert.ok(maximumSupportGap <= .01, 'Static placements have a visible supporting contact within 1cm')
    return result
  } finally { world.free() }
}
const placements = {}
const cases = []
for (const [id, amount, gold, sand] of [
  ['10k', 1_000_000, 0, 100],
  ['100k', 10_000_000, 5, 0],
  ['1m', 100_000_000, 50, 0],
]) {
  const simulation = new PlacementPhysics(assets, amount)
  try {
    let steps = 0
    for (; steps < 1200; steps++) {
      simulation.advance(1 / 60)
      if (steps >= 360 && !simulation.isActive) break
    }
    const pieces = simulation.pieces()
    const metrics = simulation.metrics()
    assert.equal(metrics.represented, amount)
    assert.equal(metrics.outsideShore, 0)
    assert.equal(metrics.belowWater, 0)
    assert.equal(pieces.filter(piece => piece.kind === 'gold').length, gold)
    assert.equal(pieces.filter(piece => piece.kind === 'sand').length, sand)
    assert.ok(pieces.every(piece => !piece.spent && piece.orientation && [...piece.position, ...piece.orientation].every(Number.isFinite)))
    placements[id] = pieces.map(piece => ({
      kind: piece.kind, value: piece.value,
      position: piece.position.map(value => Number(value.toFixed(7))),
      orientation: piece.orientation.map(value => Number(value.toFixed(8))),
    }))
    const visualGeometry = verifyVisualGeometry(placements[id], simulation.boundary)
    cases.push({ id, amount, steps, metrics, visualGeometry })
    console.log(id, JSON.stringify({ steps, ...metrics, visualGeometry }))
  } finally { simulation.dispose() }
}
const metadata = {
  generator: 'scripts/bake-comparison-placements.mjs',
  generatorSha256: createHash('sha256').update(await readFile('scripts/bake-comparison-placements.mjs')).digest('hex'),
  sourceAssets,
  physicsSourceSha256: createHash('sha256').update(await readFile('src/scene/FreeReservePhysics.ts')).digest('hex'),
  dependencySha256: Object.fromEntries(await Promise.all([
    'src/scene/containerConfig.ts', 'src/scene/shoreBoundary.ts', 'src/scene/reserveMotion.ts', 'src/scene/collisionMesh.ts', 'scripts/physics-fixture.mjs',
  ].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))),
  collisionMethod: 'Offline complete exported convex hulls; runtime free physics is unchanged. Final rounded poses are checked using every original visual vertex and original terrain/prop surfaces. Maximum allowed contact penetration 8mm, upward support gap 10mm; all visible vertices must stay above water and inside the dry shore.',
  goldFen: GOLD, sandFen: STONE, stonesPerGold: STONES_PER_GOLD, modelScale: SMALL_SCALE,
  timestep: 1 / 60, cases,
}
await writeFile('src/scene/comparisonPlacements.ts', `// Generated by scripts/bake-comparison-placements.mjs from the current exported island.\n// Runtime only consumes these static poses; switching examples does not run physics.\nexport interface ComparisonPlacement {\n  kind: 'sand' | 'gold'; value: number; position: [number, number, number]; orientation: [number, number, number, number]\n}\nexport const COMPARISON_PLACEMENT_SOURCE = ${JSON.stringify(metadata, null, 2)} as const\nexport const COMPARISON_PLACEMENTS: Record<string, ComparisonPlacement[]> = ${JSON.stringify(placements, null, 2)}\n`)
