import assert from 'node:assert/strict'
import { Vector3 } from 'three'
import { GOLD } from '../src/domain/reserve.ts'
import { CELL, MUSK_SNAPSHOT, comparisonCount, comparisonLayers, comparisonLayout } from '../src/domain/comparison.ts'
import { buildComparisonEnvelope } from '../src/scene/comparisonEnvelope.ts'

const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < Math.max(.001, Math.abs(expected) * 1e-6), `${label}: ${actual} != ${expected}`)
const counts = [0, 1, 2, 3, 4, 5, 9, 10, 13, 14, 15, 29, 30, 31, 54, 55, 56, 99, 100, 101, 999, 1000, 1001, 10_000, 10_001]
const amounts = [...counts.map(count => count * GOLD), MUSK_SNAPSHOT.amount]
let snapshot
for (const amount of amounts) {
  const geometry = buildComparisonEnvelope(amount)
  try {
    const count = comparisonCount(amount), layers = comparisonLayers(amount), layout = comparisonLayout(amount)
    const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'), cells = geometry.getAttribute('pileCell'), indices = geometry.index
    assert.equal(geometry.userData.representedCount, count)
    assert.equal(geometry.userData.layers, layers.length)
    assert.equal(geometry.userData.envelopeIncludesAirGaps, true)
    assert.equal(geometry.userData.exteriorOnly, true)
    assert.equal(normals.count, positions.count)
    assert.equal(cells.count, positions.count)
    assert.ok(positions.count <= layers.length * 32 + 80, 'Allocation must scale with layers, not nugget count')
    for (const attribute of [positions, normals, cells]) assert.ok(Array.from(attribute.array).every(Number.isFinite))
    for (const index of indices.array) assert.ok(Number.isInteger(index) && index >= 0 && index < positions.count)
    if (!count) {
      assert.equal(positions.count, 0); assert.equal(indices.count, 0)
      assert.ok(geometry.boundingBox.isEmpty())
      continue
    }
    assert.ok([...geometry.boundingBox.min.toArray(), ...geometry.boundingBox.max.toArray(), geometry.boundingSphere.radius].every(Number.isFinite))
    near(geometry.boundingBox.min.y, 0, 'Bottom remains at local zero')
    near(geometry.boundingBox.max.y, layout.height, 'Height')
    near(geometry.boundingBox.min.x, -layout.width / 2, 'Minimum X')
    near(geometry.boundingBox.max.x, layout.width / 2, 'Maximum X')
    near(geometry.boundingBox.min.z, -layout.depth / 2, 'Minimum Z')
    near(geometry.boundingBox.max.z, layout.depth / 2, 'Maximum Z')
    let signedVolume = 0, topArea = 0, bottomArea = 0, wallArea = 0
    const vertex = index => new Vector3().fromBufferAttribute(positions, indices.getX(index))
    for (let i = 0; i < indices.count; i += 3) {
      const a = vertex(i), b = vertex(i + 1), c = vertex(i + 2)
      signedVolume += a.dot(b.clone().cross(c)) / 6
      const areaVector = b.clone().sub(a).cross(c.clone().sub(a))
      const normal = new Vector3().fromBufferAttribute(normals, indices.getX(i))
      assert.ok(areaVector.dot(normal) > 0, 'Every triangle has outward winding and nonzero area')
      const area = areaVector.length() / 2
      if (normal.y > .5) topArea += area
      else if (normal.y < -.5) {
        bottomArea += area
        near(a.y, 0, 'Only the exterior bottom may face downward')
      } else wallArea += area
    }
    // Nested footprints expose exactly one horizontal surface per vertical ray.
    // Complete internal box lids would fail this by orders of magnitude.
    const baseArea = layers[0].count * CELL[0] * CELL[2]
    near(topArea, baseArea, 'Exposed top area has no covered internal lids')
    near(bottomArea, baseArea, 'Only the base contributes bottom area')
    const expectedWalls = layers.reduce((sum, layer) => {
      const fullRows = layer.rows - (layer.tail ? 1 : 0)
      const width = (fullRows ? layer.side : layer.tail) * CELL[0]
      return sum + 2 * (width + layer.rows * CELL[2]) * CELL[1]
    }, 0)
    near(wallArea, expectedWalls, 'Exterior perimeter excludes the joined partial-row wall')
    // Each represented cell includes the actual spacing around the gold model.
    // This checks the envelope, deliberately NOT the solid gold mesh volume.
    const expectedVolume = count * CELL[0] * CELL[1] * CELL[2]
    near(signedVolume, expectedVolume, 'Signed cell-envelope volume')
    if (amount === MUSK_SNAPSHOT.amount) {
      assert.ok(positions.count < 150_000, 'The snapshot must remain a bounded surface representation')
      snapshot = { count, layers: layers.length, vertices: positions.count, triangles: indices.count / 3, topArea, oldBoxTopArea: count * CELL[0] * CELL[2], relativeEnvelopeError: signedVolume / expectedVolume - 1 }
    }
  } finally { geometry.dispose() }
}
for (const bad of [-1, 1, .1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => buildComparisonEnvelope(bad))
console.log(`Comparison envelope: ${amounts.length} actual-geometry cases passed; invalid amounts rejected.`, snapshot)
