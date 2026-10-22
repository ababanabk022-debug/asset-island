export interface CollisionMesh { vertices: Float32Array; indices: Uint32Array }
export interface CollisionProxy {
  sourceSha256: string
  terrain: CollisionMesh
  obstacles: CollisionMesh[]
  diagnostics: {
    tolerance: number
    sourceTerrainTriangles: number
    terrainTriangles: number
    sourceObstacleTriangles: number
    obstacleTriangles: number
    terrainHeightSamples: number
    maximumTerrainHeightError: number
    p95TerrainHeightError: number
    obstacleSurfaceSamples: number
    maximumObstacleSurfaceError: number
    p95ObstacleSurfaceError: number
  }
}
export interface CollisionProxyHeader {
  version: 1
  sourceSha256: string
  meshes: { vertices: number; indices: number }[]
  diagnostics: CollisionProxy['diagnostics']
}

/** Browser and Node use the same baked world-space collision data. */
export function decodeCollisionProxy(bytes: ArrayBuffer): CollisionProxy {
  const view = new DataView(bytes)
  if (view.byteLength < 12 || view.getUint32(0, true) !== 0x434c5349) throw new Error('Invalid island collision proxy')
  const headerSize = view.getUint32(4, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 8, headerSize))) as CollisionProxyHeader
  if (header.version !== 1 || !/^[a-f0-9]{64}$/.test(header.sourceSha256) || header.meshes.length < 2) throw new Error('Invalid collision proxy header')
  let offset = 8 + Math.ceil(headerSize / 4) * 4
  const meshes = header.meshes.map(mesh => {
    if (!Number.isSafeInteger(mesh.vertices) || mesh.vertices < 9 || mesh.vertices % 3 ||
      !Number.isSafeInteger(mesh.indices) || mesh.indices < 3 || mesh.indices % 3 ||
      offset + (mesh.vertices + mesh.indices) * 4 > bytes.byteLength) throw new Error('Invalid collision proxy geometry')
    const vertices = new Float32Array(bytes, offset, mesh.vertices); offset += mesh.vertices * 4
    const indices = new Uint32Array(bytes, offset, mesh.indices); offset += mesh.indices * 4
    return { vertices, indices }
  })
  if (offset !== bytes.byteLength) throw new Error('Unexpected collision proxy data')
  return { sourceSha256: header.sourceSha256, terrain: meshes[0], obstacles: meshes.slice(1), diagnostics: header.diagnostics }
}

const partsCache = new WeakMap<CollisionMesh, CollisionMesh[]>()
/** Keep disconnected exact props separate, so broad phase bounds describe one
 * tree, stone or beam instead of every object sharing a material. */
export function connectedParts(mesh: CollisionMesh) {
  const cached = partsCache.get(mesh)
  if (cached) return cached
  if (mesh.indices.length < 1500) { partsCache.set(mesh, [mesh]); return [mesh] }
  const welded = new Map<string, number>(), parents: number[] = [], ids: number[] = []
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const key = `${Math.round(mesh.vertices[i] * 100000)},${Math.round(mesh.vertices[i + 1] * 100000)},${Math.round(mesh.vertices[i + 2] * 100000)}`
    let id = welded.get(key)
    if (id === undefined) { id = parents.length; welded.set(key, id); parents.push(id) }
    ids.push(id)
  }
  const find = (index: number) => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index] }
    return index
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const first = find(ids[mesh.indices[i]])
    for (let j = 1; j < 3; j++) parents[find(ids[mesh.indices[i + j]])] = first
  }
  const components = new Map<number, number[]>()
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const id = find(ids[mesh.indices[i]]), group = components.get(id) ?? []
    group.push(mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]); components.set(id, group)
  }
  const parts = [...components.values()].map(indices => {
    const remap = new Map<number, number>(), vertices: number[] = [], local: number[] = []
    for (const index of indices) {
      let id = remap.get(index)
      if (id === undefined) {
        id = vertices.length / 3; remap.set(index, id)
        vertices.push(mesh.vertices[index * 3], mesh.vertices[index * 3 + 1], mesh.vertices[index * 3 + 2])
      }
      local.push(id)
    }
    return { vertices: new Float32Array(vertices), indices: new Uint32Array(local) }
  })
  partsCache.set(mesh, parts)
  return parts
}
