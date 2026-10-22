import { readFile, mkdir, copyFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureCollisionProxy } from './generate-collision-proxy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(root, 'assets/manifests/stage-a.json'), 'utf8'))
if (manifest.schemaVersion !== 1 || manifest.assets.length !== 4) throw new Error('Invalid Stage A manifest')
const reserve = JSON.parse(await readFile(path.join(root, 'assets/manifests/reserve.json'), 'utf8'))
if (reserve.schemaVersion !== 1 || reserve.assets.length !== 1 || Math.abs(reserve.goldToSandstoneVolume - 10) > .0001) throw new Error('Invalid calibrated gold manifest')
const assets = [...manifest.assets, ...reserve.assets]
const target = path.join(root, 'public/generated')
await mkdir(target, { recursive: true })
for (const asset of assets) {
  if (!/^[a-z-]+\.glb$/.test(asset.file)) throw new Error('Invalid asset filename')
  const source = path.join(root, 'assets/runtime', asset.file)
  const bytes = await readFile(source)
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== asset.sha256 || (await stat(source)).size !== asset.bytes) throw new Error(`Asset changed: ${asset.file}. Regenerate manifest.`)
  if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error(`Invalid GLB: ${asset.file}`)
  await copyFile(source, path.join(target, asset.file))
}
await copyFile(path.join(root, 'assets/manifests/stage-a.json'), path.join(target, 'manifest.json'))
await copyFile(path.join(root, 'assets/manifests/reserve.json'), path.join(target, 'reserve-manifest.json'))
await ensureCollisionProxy()
await copyFile(path.join(root, 'assets/runtime/island-collision.bin'), path.join(target, 'island-collision.bin'))
console.log(`Validated and synchronized ${assets.length} original GLBs. Source: assets/runtime; public/generated is disposable.`)
