import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Box3, Mesh, Quaternion, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GOLD, STONE, STONES_PER_GOLD } from '../src/domain/reserve.ts'
import { COMPARISON_EXAMPLES, COMPARISON_GOLD_DIMENSIONS, COMPARISON_GOLD_VOLUME, COMPARISON_RUNTIME_SCALE, COMPARISON_GROUND, CELL, INSTANCE_LIMIT, MUSK_SNAPSHOT, comparisonBreakdown, comparisonCount, comparisonPieceLabel, comparisonLayers, comparisonCells, comparisonLayout, comparisonRatio, comparisonVolume } from '../src/domain/comparison.ts'
import { COMPARISON_PLACEMENTS, COMPARISON_PLACEMENT_SOURCE } from '../src/scene/comparisonPlacements.ts'
import { CONTAINER } from '../src/scene/containerConfig.ts'
import { createShoreBoundary } from '../src/scene/shoreBoundary.ts'
import { physicsFixture, physicsAssetHashes } from './physics-fixture.mjs'

const bytes = await readFile('assets/runtime/gold.glb')
const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
gltf.scene.updateMatrixWorld(true)
const actualBounds = new Box3().setFromObject(gltf.scene)
const actualDimensions = actualBounds.getSize(new Vector3()).toArray()
let signedVolume = 0
gltf.scene.traverse(object => {
  if (!(object instanceof Mesh)) return
  const { geometry, matrixWorld } = object
  const positions = geometry.getAttribute('position'), indices = geometry.index
  const count = indices?.count ?? positions.count
  const point = i => new Vector3().fromBufferAttribute(positions, indices ? indices.getX(i) : i).applyMatrix4(matrixWorld)
  for (let i = 0; i < count; i += 3) signedVolume += point(i).dot(point(i + 1).cross(point(i + 2))) / 6
})
const actualVolume = Math.abs(signedVolume)
const near = (actual, expected, label, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= Math.max(tolerance, Math.abs(expected) * tolerance), `${label}: ${actual} != ${expected}`)
actualDimensions.forEach((dimension, i) => near(dimension, COMPARISON_GOLD_DIMENSIONS[i], 'Dimensions match exported GLB'))
near(actualVolume, COMPARISON_GOLD_VOLUME, 'Measured solid gold volume')
assert.equal(COMPARISON_RUNTIME_SCALE, .45)
assert.equal(STONE, 10_000)
assert.equal(GOLD, 2_000_000)
assert.equal(STONES_PER_GOLD, 200)
const worldDimensions = actualDimensions.map(value => value * .45)
near(CELL[0], worldDimensions[0] + .025, 'Cell width')
near(CELL[1], worldDimensions[1], 'Cell height')
near(CELL[2], worldDimensions[2] + .025, 'Cell depth')

const examples = COMPARISON_EXAMPLES.slice(0, 3)
assert.deepEqual(examples.map(example => example.id), ['10k', '100k', '1m'])
assert.deepEqual(examples.map(example => comparisonBreakdown(example.amount)), [
  { gold: 0, sand: 100, total: 100 }, { gold: 5, sand: 0, total: 5 }, { gold: 50, sand: 0, total: 50 },
])
assert.deepEqual(examples.map(example => comparisonPieceLabel(example.amount)), ['100 块砂岩', '5 块金矿', '50 块金矿'])
assert.throws(() => comparisonCells(examples[0].amount), /完整金矿/, '100 sand must not turn into half a gold instance')
assert.equal(comparisonVolume(examples[0].amount), 0, 'Gold-only volume excludes sandstone')

// The saved render poses are tied to real source geometry, not a proxy's bounds.
const source = COMPARISON_PLACEMENT_SOURCE
assert.deepEqual(source.sourceAssets, await physicsAssetHashes(), 'Baked source assets must match the files actually served')
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
assert.equal(source.generatorSha256, await hash(source.generator))
assert.equal(source.physicsSourceSha256, await hash('src/scene/FreeReservePhysics.ts'))
for (const [path, expected] of Object.entries(source.dependencySha256)) assert.equal(await hash(path), expected, `${path} changed after pose baking`)
assert.equal(source.goldFen, GOLD); assert.equal(source.sandFen, STONE)
assert.equal(source.stonesPerGold, 200); assert.equal(source.modelScale, .45)
const assets = await physicsFixture(), shore = createShoreBoundary(assets.terrain)
let checkedVertices = 0
const rotation = new Quaternion(), vertex = new Vector3()
for (const example of examples) {
  const layout = comparisonLayout(example.amount), pieces = comparisonBreakdown(example.amount)
  assert.equal(layout.count, pieces.total)
  assert.equal(layout.goldCount, pieces.gold); assert.equal(layout.sandCount, pieces.sand)
  assert.equal(layout.unitScale, .45); assert.equal(layout.far, false)
  assert.equal(layout.radiusX, CONTAINER.waterRadius); assert.equal(layout.radiusZ, CONTAINER.waterRadius)
  near(layout.position[0], -18.4, 'Same ordinary island placement')
  near(layout.boundsMax[0], -11, 'Water never overlaps home island')
  const poses = COMPARISON_PLACEMENTS[example.id]
  assert.equal(poses.length, pieces.total)
  assert.equal(poses.filter(pose => pose.kind === 'sand').length, pieces.sand)
  assert.equal(poses.filter(pose => pose.kind === 'gold').length, pieces.gold)
  assert.equal(poses.reduce((sum, pose) => sum + pose.value, 0), example.amount)
  for (const pose of poses) {
    assert.ok([...pose.position, ...pose.orientation].every(Number.isFinite))
    near(Math.hypot(...pose.orientation), 1, 'Saved orientation is normalized', 2e-6)
    assert.equal(pose.value, pose.kind === 'sand' ? STONE : GOLD)
    rotation.fromArray(pose.orientation)
    const vertices = assets[pose.kind].vertices
    for (let i = 0; i < vertices.length; i += 3) {
      vertex.fromArray(vertices, i).multiplyScalar(.45).applyQuaternion(rotation)
      vertex.x += pose.position[0]; vertex.y += pose.position[1]; vertex.z += pose.position[2]
      assert.ok(shore.contains(vertex.x, vertex.z), 'Each original mesh vertex stays inside the real dry contour')
      assert.ok(vertex.y > CONTAINER.waterY, 'Each original mesh vertex is above water')
      assert.ok(vertex.y <= layout.boundsMax[1], 'Camera includes the final pile height')
      checkedVertices++
    }
  }
  // Generated by an independent exact visual-vertex/terrain and static-support
  // check. The baking script fails instead of publishing a hovering pose.
  const result = source.cases.find(item => item.id === example.id)
  assert.equal(result.amount, example.amount)
  assert.equal(result.metrics.awake, 0)
  assert.equal(result.metrics.represented, example.amount)
  assert.equal(result.metrics.outsideShore, 0); assert.equal(result.metrics.belowWater, 0)
  assert.ok(result.visualGeometry.maximumTerrainPenetration <= .005)
  assert.ok(result.visualGeometry.maximumStaticPenetration <= .005)
  assert.ok(result.visualGeometry.maximumSupportGap <= .008)
}
const framing = examples.map(({ amount }) => {
  const layout = comparisonLayout(amount)
  return [layout.radiusX, layout.radiusZ, layout.position, layout.boundsMin, layout.boundsMax]
})
assert.deepEqual(framing[0], framing[1]); assert.deepEqual(framing[1], framing[2])
const renderer = await readFile('src/scene/ComparisonReserve.tsx', 'utf8')
assert.doesNotMatch(renderer, /FreeReservePhysics|@dimforge\/rapier/, 'Switching examples must not instantiate another physics world')

function checkLayers(amount) {
  const expected = comparisonCount(amount), layers = comparisonLayers(amount)
  assert.equal(layers.reduce((sum, layer) => sum + layer.count, 0), expected)
  assert.ok(layers.length <= Math.ceil(Math.cbrt(3 * expected)) + 1)
  layers.forEach((layer, index) => {
    assert.equal(layer.index, index)
    for (const value of [layer.index, layer.side, layer.count, layer.rows, layer.tail]) assert.ok(Number.isSafeInteger(value))
    assert.ok(layer.side >= 1 && layer.count > 0 && layer.count <= layer.side ** 2)
    assert.equal(Math.floor(layer.count / layer.side) * layer.side + layer.tail, layer.count)
    if (index) {
      assert.equal(layers[index - 1].count, layers[index - 1].side ** 2)
      assert.equal(layer.side, layers[index - 1].side - 1)
    }
  })
  return layers
}
for (const amount of [0, GOLD, 5 * GOLD, 50 * GOLD]) {
  const layers = checkLayers(amount), cells = comparisonCells(amount)
  assert.equal(cells.length, comparisonCount(amount))
  for (const layer of layers) assert.equal(cells.filter(cell => Math.abs(cell[1] - layer.index * CELL[1]) < 1e-8).length, layer.count)
  near(comparisonVolume(amount), cells.length * actualVolume * .45 ** 3, 'Complete gold volume')
}
const exactFen = 839_000_000_000n * 69_228n / 100n
assert.equal(exactFen, 580_822_920_000_000n)
assert.equal(BigInt(MUSK_SNAPSHOT.amount), exactFen)
assert.equal(exactFen / BigInt(GOLD), 290_411_460n)
assert.equal(exactFen % BigInt(GOLD), 0n)
assert.equal(MUSK_SNAPSHOT.valuedAt, '2026-03-01')
assert.equal(MUSK_SNAPSHOT.publishedAt, '2026-03-10')
assert.equal(MUSK_SNAPSHOT.fxAt, '2026-02-27')
const giantLayers = checkLayers(MUSK_SNAPSHOT.amount), giant = comparisonLayout(MUSK_SNAPSHOT.amount)
assert.equal(giant.count, 290_411_460); assert.equal(giant.unitScale, .45); assert.equal(giant.far, true)
assert.ok(giantLayers.length < 1500)
assert.throws(() => comparisonCells(MUSK_SNAPSHOT.amount), /分层|实例/)
assert.throws(() => comparisonCells((INSTANCE_LIMIT + 1) * GOLD), /分层|实例/)
assert.ok([...giant.position, ...giant.boundsMin, ...giant.boundsMax, giant.width, giant.depth, giant.height, giant.volume].every(Number.isFinite))
assert.ok((giant.width / 2 / (giant.radiusX * .8 * .86)) ** 2 + (giant.depth / 2 / (giant.radiusZ * .8 * .86)) ** 2 < 1,
  'Every corner of the giant base fits on expanded flat sand')
assert.equal(giant.position[1], COMPARISON_GROUND)
near(giant.volume, Number(exactFen / BigInt(GOLD)) * actualVolume * .45 ** 3, 'Historical total solid volume')
assert.deepEqual(comparisonLayers(0), []); assert.deepEqual(comparisonCells(0), [])
assert.equal(comparisonLayout(0).count, 0)
assert.equal(comparisonRatio(10_000_000, 0), '你的余额为 0，暂不计算倍数')
assert.equal(comparisonRatio(10_000_000, 80_000), '对比金额是你的储备的 125 倍')
assert.ok(comparisonRatio(10_000_000, 70_000).includes('约 142.86'))
for (const amount of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  for (const operation of [comparisonBreakdown, comparisonLayers, comparisonCells, comparisonLayout, comparisonVolume]) assert.throws(() => operation(amount))
  assert.throws(() => comparisonRatio(100, amount)); assert.throws(() => comparisonRatio(amount, 100))
}
for (const amount of [1, STONE - 1, GOLD + 1, MUSK_SNAPSHOT.amount + 1]) {
  for (const operation of [comparisonCount, comparisonLayout, comparisonVolume]) assert.throws(() => operation(amount), /完整砂岩/)
  assert.throws(() => comparisonLayers(amount), /完整金矿/)
}
assert.deepEqual(comparisonBreakdown(GOLD + STONE), { gold: 1, sand: 1, total: 2 })
console.log(JSON.stringify({ result: 'passed', examples: ['100 sand', '5 gold', '50 gold'], checkedVertices,
  sameIslandRadii: [7.4, 7.4], unitScale: .45, muskGoldCount: giant.count, muskLayers: giantLayers.length,
  poseChecks: source.cases.map(item => ({ id: item.id, ...item.visualGeometry })),
  limitations: ['Node verifies sources, geometry, amounts and saved poses; browser QA verifies the actual rendered scene and entry motion.'] }, null, 2))
