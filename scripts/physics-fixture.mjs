import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { decodeCollisionProxy } from '../src/scene/collisionMesh.ts'

export async function physicsAssetHashes() {
  const hashes = Object.fromEntries(await Promise.all(['island-study', 'sandstone', 'gold'].map(async name => [
    `${name}.glb`, createHash('sha256').update(await readFile(`assets/runtime/${name}.glb`)).digest('hex'),
  ])))
  try { hashes['island-collision.bin'] = createHash('sha256').update(await readFile('assets/runtime/island-collision.bin')).digest('hex') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return hashes
}

// Read the exported geometry, not hand-sized test cubes.
async function geometry(file, match = () => true) {
  const bytes = await readFile(`assets/runtime/${file}.glb`)
  const length = bytes.readUInt32LE(12), json = JSON.parse(bytes.toString('utf8', 20, 20 + length)), base = 28 + length
  const vertices = [], indices = []
  function accessor(id, i, component = 0) {
    const a = json.accessors[id], v = json.bufferViews[a.bufferView]
    const width = a.componentType === 5123 ? 2 : a.componentType === 5121 ? 1 : 4
    const offset = base + (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * (v.byteStride ?? width * (a.type === 'VEC3' ? 3 : 1)) + component * width
    return a.componentType === 5126 ? bytes.readFloatLE(offset) : bytes.readUIntLE(offset, width)
  }
  function visit(id, parent) {
    const n = json.nodes[id]
    const local = n.matrix ? new Matrix4().fromArray(n.matrix) : new Matrix4().compose(new Vector3(...(n.translation ?? [0,0,0])), new Quaternion(...(n.rotation ?? [0,0,0,1])), new Vector3(...(n.scale ?? [1,1,1])))
    const world = parent.clone().multiply(local)
    if (n.mesh !== undefined && match(n.name)) for (const p of json.meshes[n.mesh].primitives) {
      const offset = vertices.length / 3, count = json.accessors[p.attributes.POSITION].count
      for (let i = 0; i < count; i++) vertices.push(...new Vector3(...[0,1,2].map(c => accessor(p.attributes.POSITION,i,c))).applyMatrix4(world).toArray())
      const indexCount = p.indices === undefined ? count : json.accessors[p.indices].count
      for (let i = 0; i < indexCount; i++) indices.push(offset + (p.indices === undefined ? i : accessor(p.indices,i)))
    }
    for (const child of n.children ?? []) visit(child, world)
  }
  for (const node of json.scenes[json.scene ?? 0].nodes) visit(node, new Matrix4())
  return {vertices: new Float32Array(vertices), indices: new Uint32Array(indices)}
}
export async function physicsFixture() {
  const terrain = await geometry('island-study',name=>name.includes('Warm ivory sand'))
  const assets = {terrain}
  for (const [kind, file] of [['sand','sandstone'],['gold','gold']]) {
    const {vertices} = await geometry(file)
    const heights = vertices.filter((_,i)=>i%3===1)
    const centerY = (Math.min(...heights)+Math.max(...heights))/2
    for (let i=1;i<vertices.length;i+=3) vertices[i]-=centerY
    assets[kind] = {vertices,centerY}
  }
  return assets
}
export async function freePhysicsSourceFixture() {
  const assets = await physicsFixture()
  const obstacles = await geometry('island-study', name => !/Warm.?ivory.?sand|Palm.?leaf|Sandstone.?sample|Island.?submerged.?body|Submerged.?island.?strata/.test(name))
  return { ...assets, obstacles: [obstacles] }
}
export async function freePhysicsFixture() {
  const assets = await freePhysicsSourceFixture()
  const bytes = await readFile('assets/runtime/island-collision.bin')
  const collisionProxy = decodeCollisionProxy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const hashes = await physicsAssetHashes()
  if (collisionProxy.sourceSha256 !== hashes['island-study.glb']) throw new Error('Collision proxy is stale. Run npm run assets:sync.')
  return { ...assets, collisionProxy }
}
