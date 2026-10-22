import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js'
import RAPIER from '@dimforge/rapier3d-compat'
import { connectedParts, decodeCollisionProxy } from '../src/scene/collisionMesh.ts'
import { terrainSurface } from '../src/scene/terrainSurface.ts'
import { freePhysicsSourceFixture, physicsAssetHashes } from './physics-fixture.mjs'

const target = 'assets/runtime/island-collision.bin'
const tolerance = .0015

/** Weld only identical coordinates: imported shading seams have no physical
 * meaning, but preserving them would incorrectly lock every triangle border. */
function simplify(mesh) {
  if (mesh.indices.length < 300) return mesh
  const ids = new Map(), vertices = [], remap = []
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const key = `${mesh.vertices[i]},${mesh.vertices[i + 1]},${mesh.vertices[i + 2]}`
    let id = ids.get(key)
    if (id === undefined) {
      id = vertices.length / 3; ids.set(key, id)
      vertices.push(mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2])
    }
    remap.push(id)
  }
  const welded = new Float32Array(vertices), indices = Uint32Array.from(mesh.indices, i => remap[i])
  const [reduced] = MeshoptSimplifier.simplify(indices, welded, 3, 3, tolerance, ['LockBorder', 'ErrorAbsolute'])
  const [compact, count] = MeshoptSimplifier.compactMesh(reduced)
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < compact.length; i++) {
    if (compact[i] === 0xffffffff) continue
    positions.set(welded.subarray(i * 3, i * 3 + 3), compact[i] * 3)
  }
  return { vertices: positions, indices: reduced }
}

/** Independent vertical error checks over the entire reachable dry surface,
 * including original vertices, edge midpoints, triangle centers and a 6cm grid. */
export function validateTerrainProxy(original, proxy) {
  const source = terrainSurface(original), contact = terrainSurface(proxy), errors = []
  const inspect = (x, z, y) => {
    if (y < .115 - 1e-6) return
    const hit = contact.sample(x, z)
    if (!hit) throw new Error(`Collision terrain hole at ${x},${z}`)
    errors.push(Math.abs(hit.height - y))
  }
  const { vertices: v, indices } = original
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      inspect(v[p], v[p + 2], v[p + 1])
      inspect((v[p] + v[q]) / 2, (v[p + 2] + v[q + 2]) / 2, (v[p + 1] + v[q + 1]) / 2)
    }
    inspect((v[a] + v[b] + v[c]) / 3, (v[a + 2] + v[b + 2] + v[c + 2]) / 3, (v[a + 1] + v[b + 1] + v[c + 1]) / 3)
  }
  for (let x = source.minX; x <= source.maxX; x += .06) for (let z = source.minZ; z <= source.maxZ; z += .06) {
    const hit = source.sample(x, z)
    if (hit) inspect(x, z, hit.height)
  }
  errors.sort((a, b) => a - b)
  const maximum = errors.at(-1) ?? Infinity
  if (!errors.length || maximum > .005) throw new Error(`Collision terrain error ${maximum} exceeds 5mm`)
  return { terrainHeightSamples: errors.length, maximumTerrainHeightError: maximum, p95TerrainHeightError: errors[Math.floor(errors.length * .95)] }
}

/** Bidirectional sampled surface distance for every changed fixed prop. Unlike
 * the simplifier's aggregate error estimate, this measures actual mesh faces. */
async function validateObstacleProxies(originals, proxies) {
  await RAPIER.init()
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 }), errors = []
  try {
    for (let n = 0; n < originals.length; n++) {
      const original = originals[n], proxy = proxies[n]
      if (original.indices.length === proxy.indices.length) continue
      const simplified = world.createCollider(RAPIER.ColliderDesc.trimesh(proxy.vertices, proxy.indices))
      const source = world.createCollider(RAPIER.ColliderDesc.trimesh(original.vertices, original.indices))
      for (const [mesh, target] of [[original, simplified], [proxy, source]]) {
        const { vertices: v, indices } = mesh
        const inspect = (x, y, z) => {
          const point = target.projectPoint({ x, y, z }, false)?.point
          if (!point) throw new Error('Collision prop has no matching surface')
          errors.push(Math.hypot(x - point.x, y - point.y, z - point.z))
        }
        for (let i = 0; i < v.length; i += 3) inspect(v[i], v[i + 1], v[i + 2])
        for (let i = 0; i < indices.length; i += 3) {
          const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
          inspect((v[a] + v[b] + v[c]) / 3, (v[a + 1] + v[b + 1] + v[c + 1]) / 3, (v[a + 2] + v[b + 2] + v[c + 2]) / 3)
          for (const [p, q] of [[a, b], [b, c], [c, a]]) inspect((v[p] + v[q]) / 2, (v[p + 1] + v[q + 1]) / 2, (v[p + 2] + v[q + 2]) / 2)
        }
      }
      world.removeCollider(simplified, true); world.removeCollider(source, true)
    }
  } finally { world.free() }
  errors.sort((a, b) => a - b)
  const maximum = errors.at(-1) ?? 0
  if (maximum > .005) throw new Error(`Collision prop surface error ${maximum} exceeds 5mm`)
  return { obstacleSurfaceSamples: errors.length, maximumObstacleSurfaceError: maximum, p95ObstacleSurfaceError: errors[Math.floor(errors.length * .95)] ?? 0 }
}

export async function ensureCollisionProxy(force = false) {
  const sourceSha256 = (await physicsAssetHashes())['island-study.glb']
  if (!force) {
    try {
      const bytes = await readFile(target)
      const existing = decodeCollisionProxy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      if (existing.sourceSha256 === sourceSha256 && existing.diagnostics.tolerance === tolerance &&
        Number.isFinite(existing.diagnostics.maximumObstacleSurfaceError)) return existing
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  await MeshoptSimplifier.ready
  const assets = await freePhysicsSourceFixture()
  const terrain = simplify(assets.terrain), originals = assets.obstacles.flatMap(connectedParts), obstacles = originals.map(simplify)
  const diagnostics = {
    tolerance,
    sourceTerrainTriangles: assets.terrain.indices.length / 3,
    terrainTriangles: terrain.indices.length / 3,
    sourceObstacleTriangles: originals.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
    obstacleTriangles: obstacles.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
    ...validateTerrainProxy(assets.terrain, terrain),
    ...await validateObstacleProxies(originals, obstacles),
  }
  const meshes = [terrain, ...obstacles]
  const header = Buffer.from(JSON.stringify({ version: 1, sourceSha256, diagnostics,
    meshes: meshes.map(mesh => ({ vertices: mesh.vertices.length, indices: mesh.indices.length })) }))
  const padded = Math.ceil(header.length / 4) * 4
  const data = Buffer.alloc(8 + padded + meshes.reduce((sum, mesh) => sum + (mesh.vertices.length + mesh.indices.length) * 4, 0))
  data.writeUInt32LE(0x434c5349, 0); data.writeUInt32LE(header.length, 4); header.copy(data, 8)
  let offset = 8 + padded
  for (const mesh of meshes) for (const array of [mesh.vertices, mesh.indices]) {
    Buffer.from(array.buffer, array.byteOffset, array.byteLength).copy(data, offset); offset += array.byteLength
  }
  await writeFile(target, data)
  console.log(`Baked collision proxy: terrain ${diagnostics.sourceTerrainTriangles} -> ${diagnostics.terrainTriangles} triangles; props ${diagnostics.sourceObstacleTriangles} -> ${diagnostics.obstacleTriangles}; dry height max ${(diagnostics.maximumTerrainHeightError * 1000).toFixed(2)}mm; ${data.length} bytes.`)
  return decodeCollisionProxy(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await ensureCollisionProxy(process.argv.includes('--force'))
