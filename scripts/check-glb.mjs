import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { Matrix4, Quaternion, Vector3 } from 'three'

function inspect(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF')
  const jsonLength = bytes.readUInt32LE(12)
  const data = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength))
  const binaryOffset = 20 + jsonLength + 8
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)
  let triangles = 0, meshes = 0, signedVolume = 0
  function readVec3(accessorIndex, vertex) {
    const accessor = data.accessors[accessorIndex], view = data.bufferViews[accessor.bufferView]
    assert.equal(accessor.componentType, 5126)
    const offset = binaryOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + vertex * (view.byteStride ?? 12)
    return new Vector3(bytes.readFloatLE(offset), bytes.readFloatLE(offset + 4), bytes.readFloatLE(offset + 8))
  }
  function readIndex(accessorIndex, index) {
    if (accessorIndex === undefined) return index
    const accessor = data.accessors[accessorIndex], view = data.bufferViews[accessor.bufferView]
    const width = accessor.componentType === 5125 ? 4 : accessor.componentType === 5123 ? 2 : 1
    return bytes.readUIntLE(binaryOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * (view.byteStride ?? width), width)
  }
  function visit(index, parent) {
    const node = data.nodes[index]
    const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3(...(node.translation ?? [0, 0, 0])), new Quaternion(...(node.rotation ?? [0, 0, 0, 1])), new Vector3(...(node.scale ?? [1, 1, 1])))
    const matrix = parent.clone().multiply(local)
    if (node.mesh !== undefined) {
      meshes++
      for (const primitive of data.meshes[node.mesh].primitives) {
        const accessor = data.accessors[primitive.attributes.POSITION]
        assert.ok(primitive.attributes.NORMAL !== undefined, 'Every mesh requires exported normals')
        for (let i = 0; i < accessor.count; i++) {
          const point = readVec3(primitive.attributes.POSITION, i).applyMatrix4(matrix)
          assert.ok(point.toArray().every(Number.isFinite))
          min.min(point); max.max(point)
        }
        const count = primitive.indices === undefined ? accessor.count : data.accessors[primitive.indices].count
        triangles += count / 3
        for (let i = 0; i < count; i += 3) {
          const a = readVec3(primitive.attributes.POSITION, readIndex(primitive.indices, i)).applyMatrix4(matrix)
          const b = readVec3(primitive.attributes.POSITION, readIndex(primitive.indices, i + 1)).applyMatrix4(matrix)
          const c = readVec3(primitive.attributes.POSITION, readIndex(primitive.indices, i + 2)).applyMatrix4(matrix)
          signedVolume += a.dot(b.cross(c)) / 6
        }
      }
    }
    for (const child of node.children ?? []) visit(child, matrix)
  }
  for (const node of data.scenes[data.scene ?? 0].nodes) visit(node, new Matrix4())
  assert.ok((data.images ?? []).every(image => image.bufferView !== undefined), 'Textures must be embedded, without remote dependencies')
  return { min: min.toArray(), max: max.toArray(), dimensions: max.clone().sub(min).toArray(), triangles, meshes, embeddedTextures: (data.images ?? []).length, meshVolume: Math.abs(signedVolume) }
}
const manifest = JSON.parse(await readFile('assets/manifests/stage-a.json', 'utf8'))
const reserve = JSON.parse(await readFile('assets/manifests/reserve.json', 'utf8'))
const result = {}
for (const asset of [...manifest.assets, ...reserve.assets]) {
  const measured = inspect(await readFile(`assets/runtime/${asset.file}`))
  measured.dimensions.forEach((dimension, index) => assert.ok(Math.abs(dimension - asset.dimensionsGltfXYZ[index]) < .0002, `${asset.id}: export dimension mismatch`))
  assert.equal(measured.triangles, asset.triangles)
  if (asset.id !== 'island-study') assert.ok(Math.abs(measured.min[1]) < .03, `${asset.id}: bottom anchor must be within 3cm of ground`)
  result[asset.id] = measured
}
const probe = inspect(await readFile('assets/runtime/export-probe.glb'))
probe.dimensions.forEach(d => assert.ok(Math.abs(d - 1) < .00001))
assert.ok(Math.abs(probe.min[1]) < .00001, 'Z-up to Y-up conversion must retain bottom anchor')
result.oneMetreExportProbe = probe
result.goldToSandstoneVolume = result.gold.meshVolume / result.sandstone.meshVolume
assert.ok(Math.abs(result.goldToSandstoneVolume - 10) < .0001, `Exported gold must equal 10 sandstone volumes: ${result.goldToSandstoneVolume}; gold=${result.gold.meshVolume}; sand=${result.sandstone.meshVolume}`)
await writeFile('docs/asset-check.json', JSON.stringify(result, null, 2))
console.log('GLB dimensions, triangles, textures, normals, anchors, 1m probe and exported 10:1 gold volume passed.', result.goldToSandstoneVolume)
