/** Exact height/normal queries over the exported, single-valued island mesh.
 * A small XZ index avoids scanning the whole mesh when sampling a collision
 * surface. The original triangles remain the source of shore and ground data. */
export interface TerrainMesh { vertices: Float32Array; indices: Uint32Array }
interface Triangle {
  x: number; z: number; ux: number; uz: number; vx: number; vz: number
  inverse: number; ax: number; az: number; offset: number
  normal: { x: number; y: number; z: number }
}
export interface TerrainHit { height: number; normal: { x: number; y: number; z: number } }
const INDEX_STEP = .35
const surfaces = new WeakMap<TerrainMesh, TerrainSurface>()


export class TerrainSurface {
  readonly minX: number
  readonly minZ: number
  readonly maxX: number
  readonly maxZ: number
  private width: number
  private depth: number
  private triangles: Triangle[] = []
  private buckets: number[][]

  constructor(mesh: TerrainMesh) {
    const { vertices: v, indices } = mesh
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (let i = 0; i < v.length; i += 3) {
      minX = Math.min(minX, v[i]); minZ = Math.min(minZ, v[i + 2])
      maxX = Math.max(maxX, v[i]); maxZ = Math.max(maxZ, v[i + 2])
    }
    this.minX = minX; this.minZ = minZ; this.maxX = maxX; this.maxZ = maxZ
    this.width = Math.floor((maxX - minX) / INDEX_STEP) + 1
    this.depth = Math.floor((maxZ - minZ) / INDEX_STEP) + 1
    this.buckets = Array.from({ length: this.width * this.depth }, () => [])
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
      const x = v[a], z = v[a + 2], ux = v[b] - x, uz = v[b + 2] - z, vx = v[c] - x, vz = v[c + 2] - z
      const determinant = ux * vz - uz * vx
      if (Math.abs(determinant) < 1e-12) continue
      const inverse = 1 / determinant, uy = v[b + 1] - v[a + 1], vy = v[c + 1] - v[a + 1]
      const ax = (uy * vz - vy * uz) * inverse, az = (ux * vy - vx * uy) * inverse
      const norm = Math.hypot(ax, 1, az)
      const id = this.triangles.length
      this.triangles.push({ x, z, ux, uz, vx, vz, inverse, ax, az, offset: v[a + 1] - ax * x - az * z,
        normal: { x: -ax / norm, y: 1 / norm, z: -az / norm } })
      const startX = Math.max(0, Math.floor((Math.min(x, v[b], v[c]) - minX) / INDEX_STEP))
      const endX = Math.min(this.width - 1, Math.floor((Math.max(x, v[b], v[c]) - minX) / INDEX_STEP))
      const startZ = Math.max(0, Math.floor((Math.min(z, v[b + 2], v[c + 2]) - minZ) / INDEX_STEP))
      const endZ = Math.min(this.depth - 1, Math.floor((Math.max(z, v[b + 2], v[c + 2]) - minZ) / INDEX_STEP))
      for (let ix = startX; ix <= endX; ix++) for (let iz = startZ; iz <= endZ; iz++) this.buckets[ix * this.depth + iz].push(id)
    }
  }

  sample(x: number, z: number): TerrainHit | null {
    if (!Number.isFinite(x) || !Number.isFinite(z) || x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return null
    const ix = Math.min(this.width - 1, Math.floor((x - this.minX) / INDEX_STEP))
    const iz = Math.min(this.depth - 1, Math.floor((z - this.minZ) / INDEX_STEP))
    for (const id of this.buckets[ix * this.depth + iz]) {
      const t = this.triangles[id], dx = x - t.x, dz = z - t.z
      const u = (dx * t.vz - dz * t.vx) * t.inverse, v = (t.ux * dz - t.uz * dx) * t.inverse
      if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7) {
        return { height: t.ax * x + t.az * z + t.offset, normal: t.normal }
      }
    }
    return null
  }
}

export function terrainSurface(mesh: TerrainMesh) {
  let surface = surfaces.get(mesh)
  if (!surface) { surface = new TerrainSurface(mesh); surfaces.set(mesh, surface) }
  return surface
}
