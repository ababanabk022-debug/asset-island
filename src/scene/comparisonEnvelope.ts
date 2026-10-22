import { BufferGeometry, Float32BufferAttribute } from 'three'
import { CELL, comparisonLayers, type PileLayer } from '../domain/comparison.ts'

type Rect = { x0: number; x1: number; z0: number; z1: number }
type Point = [number, number, number]
function footprint(layer: PileLayer): Rect[] {
  const fullRows = layer.rows - (layer.tail ? 1 : 0)
  const z0 = -layer.rows * CELL[2] / 2, middle = z0 + fullRows * CELL[2]
  const rectangles: Rect[] = []
  if (fullRows) rectangles.push({ x0: -layer.side * CELL[0] / 2, x1: layer.side * CELL[0] / 2, z0, z1: middle })
  if (layer.tail) rectangles.push({ x0: -layer.tail * CELL[0] / 2, x1: layer.tail * CELL[0] / 2, z0: middle, z1: middle + CELL[2] })
  return rectangles
}
function subtract(rect: Rect, cover: Rect): Rect[] {
  const x0 = Math.max(rect.x0, cover.x0), x1 = Math.min(rect.x1, cover.x1)
  const z0 = Math.max(rect.z0, cover.z0), z1 = Math.min(rect.z1, cover.z1)
  if (x0 >= x1 || z0 >= z1) return [rect]
  return [
    { x0: rect.x0, x1: x0, z0: rect.z0, z1: rect.z1 },
    { x0: x1, x1: rect.x1, z0: rect.z0, z1: rect.z1 },
    { x0, x1, z0: rect.z0, z1: z0 },
    { x0, x1, z0: z1, z1: rect.z1 },
  ].filter(r => r.x1 - r.x0 > 1e-9 && r.z1 - r.z0 > 1e-9)
}

/** Closed UNION surface of exact integer storage cells, including their air
 * gaps. Covered horizontal faces and the joined final-row wall are absent.
 * Front-to-back layer order also lets the depth buffer reject hidden walls.
 * Work/allocation scale with layer count, never with the nugget count. */
export function buildComparisonEnvelope(amount: number): BufferGeometry {
  const layers = comparisonLayers(amount), footprints = layers.map(footprint)
  const positions: number[] = [], normals: number[] = [], cells: number[] = [], indices: number[] = []
  const quad = (corners: Point[], normal: Point, layer: PileLayer) => {
    const offset = positions.length / 3
    const [a, b, c] = corners
    const ab = b.map((v, i) => v - a[i]), ac = c.map((v, i) => v - a[i])
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
    if (cross.reduce((sum, v, i) => sum + v * normal[i], 0) < 0) corners.reverse()
    for (const [x, y, z] of corners) {
      positions.push(x, y, z); normals.push(...normal)
      cells.push(x / CELL[0] + layer.side / 2, y / CELL[1], z / CELL[2] + layer.rows / 2)
    }
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
  }
  const horizontal = (rect: Rect, y: number, normalY: number, layer: PileLayer) => quad([
    [rect.x0, y, rect.z0], [rect.x0, y, rect.z1], [rect.x1, y, rect.z1], [rect.x1, y, rect.z0],
  ], [0, normalY, 0], layer)
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index], rectangles = footprints[index]
    const y0 = layer.index * CELL[1], y1 = (layer.index + 1) * CELL[1]
    // Subtract the next footprint instead of stacking complete boxes. A single
    // camera ray can now meet only the exposed top surface, not 2,323 hidden lids.
    let exposed = rectangles
    for (const cover of footprints[index + 1] ?? []) exposed = exposed.flatMap(rect => subtract(rect, cover))
    for (const rect of exposed) horizontal(rect, y1, 1, layer)
    if (index === 0) for (const rect of rectangles) horizontal(rect, y0, -1, layer)

    const first = rectangles[0], last = rectangles[rectangles.length - 1]
    const boundary: [number, number][] = rectangles.length === 1
      ? [[first.x0, first.z0], [first.x1, first.z0], [first.x1, first.z1], [first.x0, first.z1]]
      : [[first.x0, first.z0], [first.x1, first.z0], [first.x1, first.z1], [last.x1, first.z1],
        [last.x1, last.z1], [last.x0, last.z1], [last.x0, first.z1], [first.x0, first.z1]]
    for (let edge = 0; edge < boundary.length; edge++) {
      const [ax, az] = boundary[edge], [bx, bz] = boundary[(edge + 1) % boundary.length]
      const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz)
      if (length < 1e-9) continue
      quad([[ax, y0, az], [ax, y1, az], [bx, y1, bz], [bx, y0, bz]], [dz / length, 0, -dx / length], layer)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  geometry.setAttribute('pileCell', new Float32BufferAttribute(cells, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingBox(); geometry.computeBoundingSphere()
  geometry.userData = { representedCount: layers.reduce((count, layer) => count + layer.count, 0), layers: layers.length, envelopeIncludesAirGaps: true, exteriorOnly: true }
  return geometry
}
