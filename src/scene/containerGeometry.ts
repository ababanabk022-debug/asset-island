import { BufferGeometry, Float32BufferAttribute } from 'three'
import { CONTAINER } from './containerConfig.ts'

/** Shared outline for the surface and its water cutaway. Small irregularities
 * read as a body of water rather than a manufactured vessel. */
function waterOutline(angle: number) {
  return 1 + .0032 * Math.sin(angle * 5 + .6) + .0018 * Math.cos(angle * 9 - .3)
}

export function createWaterSurface(radius: number) {
  const segments = 128, rings = 22
  const positions = [0, 0, 0], indices: number[] = []
  for (let ring = 1; ring <= rings; ring++) for (let i = 0; i < segments; i++) {
    const angle = i / segments * Math.PI * 2
    const t = ring / rings
    const r = radius * t * (1 + (waterOutline(angle) - 1) * t ** 4)
    positions.push(Math.cos(angle) * r, 0, Math.sin(angle) * r)
  }
  for (let i = 0; i < segments; i++) indices.push(0, 1 + (i + 1) % segments, 1 + i)
  for (let ring = 0; ring < rings - 1; ring++) for (let i = 0; i < segments; i++) {
    const a = 1 + ring * segments + i, b = 1 + ring * segments + (i + 1) % segments
    const c = a + segments, d = b + segments
    indices.push(a, b, c, b, d, c)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

export function createWaterCutaway(radius: number) {
  const segments = 128, rings = 6
  const positions: number[] = [], indices: number[] = []
  for (let ring = 0; ring <= rings; ring++) for (let i = 0; i < segments; i++) {
    const angle = i / segments * Math.PI * 2
    const t = ring / rings
    const r = radius * waterOutline(angle)
    positions.push(Math.cos(angle) * r, CONTAINER.floorY + (CONTAINER.waterY - CONTAINER.floorY) * t, Math.sin(angle) * r)
  }
  for (let ring = 0; ring < rings; ring++) for (let i = 0; i < segments; i++) {
    const a = ring * segments + i, b = ring * segments + (i + 1) % segments
    const c = a + segments, d = b + segments
    indices.push(a, c, b, b, c, d)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}
