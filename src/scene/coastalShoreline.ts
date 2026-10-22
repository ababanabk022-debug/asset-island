import { Mesh, Vector3, type Group } from 'three'
import { CONTAINER } from './containerConfig'

/** Sample the actual exported beach/water intersection, not an ellipse.
 * Only used for foam and optical depth; collision geometry is unchanged. */
export function coastalShoreline(scene: Group) {
  const segments: [number, number, number, number][] = []
  const point = new Vector3()
  scene.updateMatrixWorld(true)
  scene.traverse(object => {
    if (!(object instanceof Mesh) || !/Warm.?ivory.?sand/.test(object.name + object.parent?.name)) return
    const attribute = object.geometry.getAttribute('position')
    const vertices = Array.from({ length: attribute.count }, (_, i) => {
      point.fromBufferAttribute(attribute, i).applyMatrix4(object.matrixWorld)
      return [point.x, point.y, point.z]
    })
    const indices = object.geometry.index
    for (let i = 0; i < (indices?.count ?? attribute.count); i += 3) {
      const triangle = [0, 1, 2].map(j => vertices[indices ? indices.getX(i + j) : i + j])
      const crossing: [number, number][] = []
      for (let j = 0; j < 3; j++) {
        const a = triangle[j], b = triangle[(j + 1) % 3]
        if ((a[1] < CONTAINER.waterY) === (b[1] < CONTAINER.waterY)) continue
        const t = (CONTAINER.waterY - a[1]) / (b[1] - a[1])
        crossing.push([a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t])
      }
      if (crossing.length === 2) segments.push([...crossing[0], ...crossing[1]])
    }
  })
  if (!segments.length) throw new Error('Exported island has no shoreline')
  return Float32Array.from({ length: 128 }, (_, i) => {
    const angle = i / 128 * Math.PI * 2, dx = Math.cos(angle), dz = Math.sin(angle)
    let radius = 0
    for (const [ax, az, bx, bz] of segments) {
      const sx = bx - ax, sz = bz - az, denominator = dx * sz - dz * sx
      if (Math.abs(denominator) < .00001) continue
      const distance = (ax * sz - az * sx) / denominator
      const along = (ax * dz - az * dx) / denominator
      if (along >= 0 && along <= 1 && distance > radius) radius = distance
    }
    if (radius <= 0) throw new Error('Incomplete exported shoreline')
    return radius
  })
}
