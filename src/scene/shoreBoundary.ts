import { CONTAINER } from './containerConfig.ts'

export interface ShoreTerrain { vertices: Float32Array; indices: Uint32Array }
export type ShorePoint = [number, number]
interface Edge { ax: number; az: number; dx: number; dz: number; squared: number; nx: number; nz: number }

/** The exported island is a continuous, star-shaped heightfield. Its actual
 * intersection with a dry sand contour defines play space, independent of the
 * decorative water disc. All inputs are already transformed to world space. */
export class ShoreBoundary {
  readonly points: ShorePoint[]
  readonly minRadius: number
  readonly maxRadius: number
  readonly height: number
  private edges: Edge[]
  private innerRadius: number

  constructor(points: ShorePoint[], height: number) {
    this.points = points
    this.height = height
    const radii = points.map(([x, z]) => Math.hypot(x, z))
    this.minRadius = Math.min(...radii)
    this.maxRadius = Math.max(...radii)
    this.edges = points.map(([ax, az], i) => {
      const [bx, bz] = points[(i + 1) % points.length], dx = bx - ax, dz = bz - az
      const squared = dx * dx + dz * dz, length = Math.sqrt(squared)
      return { ax, az, dx, dz, squared, nx: dz / length, nz: -dx / length }
    })
    this.innerRadius = this.clearance(0, 0).distance
  }

  radiusAt(angle: number) {
    const full = Math.PI * 2, normal = ((angle % full) + full) % full
    const edge = this.edges[Math.floor(normal / full * this.points.length) % this.points.length]
    const x = Math.cos(angle), z = Math.sin(angle)
    return (edge.ax * edge.dz - edge.az * edge.dx) / (x * edge.dz - z * edge.dx)
  }

  /** Exact distance to the sampled polygon, with the outward normal of its
   * closest point. Used near the edge only; interior motion has no extra force. */
  clearance(x: number, z: number) {
    let squared = Infinity, nx = 0, nz = 0
    for (const edge of this.edges) {
      const t = Math.max(0, Math.min(1, ((x - edge.ax) * edge.dx + (z - edge.az) * edge.dz) / edge.squared))
      const dx = x - edge.ax - t * edge.dx, dz = z - edge.az - t * edge.dz
      const distance = dx * dx + dz * dz
      if (distance < squared) { squared = distance; nx = edge.nx; nz = edge.nz }
    }
    const inside = Math.hypot(x, z) <= this.radiusAt(Math.atan2(z, x)) + 1e-8
    return { distance: Math.sqrt(squared) * (inside ? 1 : -1), nx, nz }
  }

  contains(x: number, z: number, margin = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(margin)) return false
    const radius = Math.hypot(x, z)
    if (radius + Math.max(0, margin) <= this.innerRadius) return true
    if (radius > this.radiusAt(Math.atan2(z, x)) + 1e-8) return false
    return margin <= 0 || this.clearance(x, z).distance >= margin - 1e-8
  }

  /** Find the nearest safe position along the requested radial direction.
   * Per-piece inset uses true edge distance, rather than subtracting a radius
   * from a circle or allowing large golds to overhang the coast. */
  project(x: number, z: number, margin = 0): ShorePoint {
    if (![x, z, margin].every(Number.isFinite)) throw new Error('Invalid shore target')
    if (this.contains(x, z, margin)) return [x, z]
    const length = Math.hypot(x, z)
    if (!length) return [0, 0]
    const dx = x / length, dz = z / length
    let low = 0, high = Math.min(length, this.radiusAt(Math.atan2(z, x)))
    for (let i = 0; i < 18; i++) {
      const distance = (low + high) / 2
      if (this.contains(dx * distance, dz * distance, margin)) low = distance
      else high = distance
    }
    return [dx * low, dz * low]
  }
}

const boundaries = new WeakMap<ShoreTerrain, Map<number, ShoreBoundary>>()
export function createShoreBoundary(terrain: ShoreTerrain, height = CONTAINER.waterY + CONTAINER.shoreClearance) {
  const cached = boundaries.get(terrain)?.get(height)
  if (cached) return cached
  const { vertices, indices } = terrain
  const segments: [number, number, number, number][] = []
  for (let i = 0; i < indices.length; i += 3) {
    const crossing: ShorePoint[] = []
    for (let edge = 0; edge < 3; edge++) {
      const a = indices[i + edge] * 3, b = indices[i + (edge + 1) % 3] * 3
      if ((vertices[a + 1] < height) === (vertices[b + 1] < height)) continue
      const t = (height - vertices[a + 1]) / (vertices[b + 1] - vertices[a + 1])
      crossing.push([vertices[a] + (vertices[b] - vertices[a]) * t, vertices[a + 2] + (vertices[b + 2] - vertices[a + 2]) * t])
    }
    if (crossing.length === 2 && Math.hypot(crossing[0][0] - crossing[1][0], crossing[0][1] - crossing[1][1]) > 1e-8) {
      segments.push([...crossing[0], ...crossing[1]])
    }
  }
  if (!segments.length) throw new Error('Exported island has no dry shore contour')
  const points: ShorePoint[] = Array.from({ length: 128 }, (_, i) => {
    const angle = i / 128 * Math.PI * 2, dx = Math.cos(angle), dz = Math.sin(angle)
    let radius = 0
    for (const [ax, az, bx, bz] of segments) {
      const sx = bx - ax, sz = bz - az, denominator = dx * sz - dz * sx
      if (Math.abs(denominator) < 1e-9) continue
      const distance = (ax * sz - az * sx) / denominator, along = (ax * dz - az * dx) / denominator
      if (along >= -1e-8 && along <= 1 + 1e-8 && distance > radius) radius = distance
    }
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('Incomplete exported dry shore contour')
    return [dx * radius, dz * radius]
  })
  const boundary = new ShoreBoundary(points, height)
  const heights = boundaries.get(terrain) ?? new Map<number, ShoreBoundary>()
  heights.set(height, boundary); boundaries.set(terrain, heights)
  return boundary
}
