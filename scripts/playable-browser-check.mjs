import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { Box3, Matrix4, Mesh, PerspectiveCamera, Plane, Quaternion, Raycaster, Sphere, Texture, Vector2, Vector3 } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GOLD, STONE, STONES_PER_GOLD, DEMO_LIMIT } from '../src/domain/reserve.ts'
import { createShoreBoundary } from '../src/scene/shoreBoundary.ts'

const base = process.env.TEST_URL || 'http://127.0.0.1:5186'
async function loadModel(path) {
  const data = await readFile(path)
  // Node only needs authored geometry for the shore and stale-bounds probes.
  // Browser rendering below still loads and decodes the untouched real assets.
  const loader = new GLTFLoader().register(() => ({
    name: 'test-geometry-texture-placeholder',
    loadTexture: () => Promise.resolve(new Texture()),
  }))
  const { scene } = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '')
  scene.updateMatrixWorld(true)
  return scene
}
const sandstoneModel = await loadModel('assets/runtime/sandstone.glb')
const goldModel = await loadModel('assets/runtime/gold.glb')
const shorelineModel = await loadModel('assets/runtime/island-study.glb')
function pieceGeometry(scene) {
  const bounds = new Box3().setFromObject(scene), centerY = (bounds.min.y + bounds.max.y) / 2
  const spheres = [], vertices = []
  let radius = 0
  scene.traverse(object => {
    if (!(object instanceof Mesh)) return
    const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld).translate(0, -centerY, 0)
    geometry.computeBoundingSphere()
    spheres.push(geometry.boundingSphere.clone())
    const points = geometry.getAttribute('position')
    for (let i = 0; i < points.count; i++) {
      const x = points.getX(i), y = points.getY(i), z = points.getZ(i)
      vertices.push([x, y, z]); radius = Math.max(radius, Math.hypot(x, y, z))
    }
    geometry.dispose()
  })
  return { spheres, vertices, radius }
}
const sourceGeometry = { sand: pieceGeometry(sandstoneModel), gold: pieceGeometry(goldModel) }
const sandstoneSpheres = sourceGeometry.sand.spheres
const shorelineMeshes = [], landMeshes = [], terrainVertices = [], terrainIndices = []
shorelineModel.traverse(object => {
  if (!(object instanceof Mesh)) return
  shorelineMeshes.push(object)
  if (!/Warm.?ivory.?sand/.test(object.name + object.parent?.name)) return
  landMeshes.push(object)
  const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld)
  const points = geometry.getAttribute('position'), offset = terrainVertices.length / 3
  for (const value of points.array) terrainVertices.push(value)
  if (geometry.index) for (const index of geometry.index.array) terrainIndices.push(index + offset)
  else for (let i = 0; i < points.count; i++) terrainIndices.push(offset + i)
  geometry.dispose()
})
assert.ok(landMeshes.length, 'the authored dry land and continuous shallow shelf are present')
const shoreBoundary = createShoreBoundary({ vertices: Float32Array.from(terrainVertices), indices: Uint32Array.from(terrainIndices) })
const pieceScale = piece => .45 * Math.cbrt(piece.value / (piece.kind === 'gold' ? GOLD : STONE) * piece.factor)
function lowestModelPoint(piece) {
  const quaternion = new Quaternion().fromArray(piece.orientation), scale = pieceScale(piece), vertex = new Vector3()
  let lowest = Infinity
  for (const point of sourceGeometry[piece.kind].vertices) {
    vertex.fromArray(point).multiplyScalar(scale).applyQuaternion(quaternion)
    lowest = Math.min(lowest, vertex.y + piece.position[1])
  }
  return lowest
}
function initialInstanceBounds(pieces) {
  const matrix = new Matrix4(), quaternion = new Quaternion()
  return sandstoneSpheres.map(source => {
    const combined = new Sphere().makeEmpty()
    for (const piece of pieces.filter(value => value.kind === 'sand')) {
      quaternion.fromArray(piece.orientation)
      const scale = .45 * Math.cbrt(piece.value / 10_000 * piece.factor)
      matrix.compose(new Vector3(...piece.position), quaternion, new Vector3(scale, scale, scale))
      combined.union(source.clone().applyMatrix4(matrix))
    }
    return combined
  })
}
if (process.argv.includes('--geometry-only')) {
  assert.ok(sandstoneSpheres.length > 0)
  assert.ok(sandstoneSpheres.every(sphere => Number.isFinite(sphere.radius) && sphere.radius > 0))
  assert.ok(shorelineMeshes.length > 0)
  assert.ok(sourceGeometry.gold.vertices.length)
  console.log(JSON.stringify({ sandstoneParts: sandstoneSpheres.length, shorelineMeshes: shorelineMeshes.length,
    dryShore: { points: shoreBoundary.points.length, minRadius: shoreBoundary.minRadius, maxRadius: shoreBoundary.maxRadius }, browserLaunched: false }))
  process.exit(0)
}
const assetHashes = Object.fromEntries(await Promise.all(
  ['island-study.glb', 'sandstone.glb', 'gold.glb', 'island-collision.bin'].map(async name =>
    [name, createHash('sha256').update(await readFile(`assets/runtime/${name}`)).digest('hex')]),
))
const checkStartedAt = Date.now()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' })
const errors = [], checks = [], samples = []
const output = 'docs/playable-screenshots'
await mkdir(output, { recursive: true })
page.on('pageerror', error => errors.push(error.message))
const reserve = () => page.evaluate(() => window.__reserveInspect())
const island = () => page.evaluate(() => window.__islandInspect())
const live = snapshot => snapshot.pieces.filter(piece => !piece.spent)
const ledger = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('time-island-rebuild:reserve-demo:v1')))
const amount = value => page.waitForFunction(expected => window.__reserveInspect?.().amount === expected, value)
const ready = () => page.getByText('三维小岛加载完成', { exact: true }).waitFor()
const idle = () => page.waitForFunction(() => window.__reserveInspect?.().pending === false, undefined, { timeout: 12000 })
const capture = name => page.screenshot({ path: `${output}/${name}.png` })
const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]))
const checkMoney = (snapshot, expected) => {
  assert.equal(snapshot.amount, expected)
  assert.equal(snapshot.represented, expected, 'the physical world represents the full committed balance')
  assert.equal(snapshot.outsideShore, 0, 'retained money stays within the actual dry-land outline')
  assert.equal(snapshot.belowWater, 0, 'retained money never sinks below the water surface')
  assert.equal(live(snapshot).reduce((sum, piece) => sum + piece.value, 0), expected, 'live bodies conserve integer-fen value')
  for (const piece of snapshot.pieces) {
    assert.ok(piece.position.every(Number.isFinite))
    assert.ok(piece.orientation.every(Number.isFinite))
  }
}
const checkContainer = snapshot => {
  const { waterRadius, waterY, wallTop } = snapshot.container
  assert.ok(Number.isFinite(waterRadius) && waterRadius > shoreBoundary.maxRadius, 'visible water extends beyond the real dry-land outline')
  for (const piece of live(snapshot)) {
    assert.ok(shoreBoundary.contains(piece.position[0], piece.position[2]), `body ${piece.id} escaped the authored dry shore`)
    assert.ok(lowestModelPoint(piece) >= waterY - .03, `body ${piece.id} has submerged model geometry`)
    assert.ok(piece.position[1] < wallTop + 2, `settled body ${piece.id} remained outside the play height`)
  }
}
async function grabVisible() {
  const canvas = await page.locator('canvas').boundingBox()
  const candidates = live(await reserve()).filter(piece => piece.screen && piece.depth > -1 && piece.depth < 1 &&
    piece.screen[0] > canvas.x + 30 && piece.screen[0] < canvas.x + canvas.width - 30 &&
    piece.screen[1] > canvas.y + 30 && piece.screen[1] < canvas.y + canvas.height - 30)
    .sort((a, b) => a.depth - b.depth)
  assert.ok(candidates.length, 'at least one live stone is visible in the canvas')
  for (const candidate of candidates.slice(0, 12)) {
    await page.mouse.move(...candidate.screen)
    await page.mouse.down()
    await page.waitForTimeout(35)
    const snapshot = await reserve()
    if (snapshot.dragging) {
      const id = typeof snapshot.dragging === 'string' ? snapshot.dragging : candidate.id
      return live(snapshot).find(piece => piece.id === id) ?? candidate
    }
    await page.mouse.up()
  }
  assert.fail('a visible stone could not be grabbed with a real pointer')
}
async function setReduced(enabled) {
  await page.getByRole('button', { name: '打开设置', exact: true }).click()
  await page.getByLabel('减少动态效果', { exact: true }).setChecked(enabled)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
}

try {
  await page.goto(base); await ready()
  for (const [name, expectedHash] of Object.entries(assetHashes)) {
    const response = await page.request.get(`${base}/generated/${name}`)
    assert.ok(response.ok(), `the tested page serves ${name}`)
    assert.equal(createHash('sha256').update(await response.body()).digest('hex'), expectedHash,
      `the served ${name} matches the frozen test asset`)
  }
  await page.waitForFunction(() => typeof window.__reserveInspect === 'function')
  await page.waitForTimeout(1800)
  const initial = await reserve()
  checkMoney(initial, 80_000)
  assert.equal(live(initial).length, 8)
  assert.ok(initial.obstacleMeshes > 0, 'tree/house scene colliders are present')
  await capture('01-cylinder-island')
  await page.getByRole('button', { name: '近看', exact: true }).click()
  await page.waitForTimeout(950)

  // Sample a real new body before it reaches the ground: the cloud is a
  // vertical source, while incidental movement after contact remains physical.
  const originalIds = new Set(live(initial).map(piece => piece.id))
  await page.getByLabel('交易金额').fill('100')
  await page.getByTestId('transaction-income').click()
  await amount(90_000)
  const entry = await reserve()
  const { cloud, dropRadius } = entry.container
  const falling = live(entry).find(piece => !originalIds.has(piece.id) && piece.position[1] > cloud[1] - 1.5)
  assert.ok(falling, 'income creates a new stone high beneath the cloud immediately')
  assert.ok(Math.hypot(falling.position[0] - cloud[0], falling.position[2] - cloud[2]) <= dropRadius + .15,
    'the emitter remains directly beneath the current elevated cloud')
  await page.waitForTimeout(100)
  const fallingLater = live(await reserve()).find(piece => piece.id === falling.id)
  assert.ok(fallingLater)
  assert.ok(fallingLater.position[1] < falling.position[1] - .025, 'new stone falls down under gravity')
  assert.ok(Math.hypot(fallingLater.position[0] - falling.position[0], fallingLater.position[2] - falling.position[2]) < .15,
    'the pre-contact path is predominantly vertical')
  assert.ok([...originalIds].every(id => live(entry).some(piece => piece.id === id)), 'income preserves existing bodies rather than rebuilding the pile')
  await capture('02-cloud-drop')
  await idle()
  checkMoney(await reserve(), 90_000)
  samples.push({ name: 'vertical-cloud-drop', id: falling.id, cloud, dropRadius, from: falling.position, to: fallingLater.position })
  checks.push('Income falls vertically from the cloud; existing body IDs and full committed value are preserved')

  // The first ray grab primes Three's InstancedMesh bounds around nine bodies.
  // A subsequent grab at the true dry shore must lie outside those old spheres.
  await page.getByRole('button', { name: '回到初始视角', exact: true }).click()
  await page.waitForTimeout(1100)
  const compact = await reserve(), activity = compact.container
  const compactRadius = Math.max(...live(compact).map(piece => Math.hypot(piece.position[0], piece.position[2])))
  const initialSpheres = initialInstanceBounds(live(compact))
  assert.equal(live(compact).length, 9, 'the first raycast starts with only nine bodies')
  checkContainer(compact)
  const edgeBody = await grabVisible()
  const edgeCanvas = await page.locator('canvas').boundingBox(), edgePose = (await island()).camera
  const projection = new PerspectiveCamera(39, edgeCanvas.width / edgeCanvas.height, edgePose.near, edgePose.far)
  projection.position.fromArray(edgePose.position); projection.lookAt(new Vector3(...edgePose.target)); projection.updateMatrixWorld()
  const lift = Math.min(3.2, Math.max(.95, edgeBody.position[1] + .85))
  const pointer = new Vector2((edgeBody.screen[0] - edgeCanvas.x) / edgeCanvas.width * 2 - 1,
    -(edgeBody.screen[1] - edgeCanvas.y) / edgeCanvas.height * 2 + 1)
  const ray = new Raycaster(); ray.setFromCamera(pointer, projection)
  const intersection = ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -lift), new Vector3())
  assert.ok(intersection)
  const offset = new Vector3(edgeBody.position[0], lift, edgeBody.position[2]).sub(intersection)
  const bodyRadius = sourceGeometry[edgeBody.kind].radius * pieceScale(edgeBody)
  const topDown = new Raycaster(), targetRay = new Raycaster()
  const candidates = []
  for (let i = 0; i < 96; i++) {
    const angle = Math.PI * 2 * i / 96
    const outer = shoreBoundary.radiusAt(angle)
    const [x, z] = shoreBoundary.project(Math.cos(angle) * outer, Math.sin(angle) * outer, bodyRadius + .12)
    topDown.set(new Vector3(x, activity.cloud[1] + 1, z), new Vector3(0, -1, 0))
    const landHit = topDown.intersectObjects(landMeshes, false)[0]
    if (!landHit || landHit.point.y < shoreBoundary.height || landHit.point.y + bodyRadius > lift - .1) continue
    const propHit = topDown.intersectObjects(shorelineMeshes, false)[0]
    if (propHit && propHit.distance < landHit.distance - .025) continue
    const predictedLand = new Vector3(x, landHit.point.y + bodyRadius * .7, z).project(projection)
    targetRay.setFromCamera(new Vector2(predictedLand.x, predictedLand.y), projection)
    if (initialSpheres.some(sphere => targetRay.ray.intersectsSphere(new Sphere(sphere.center, sphere.radius + .1)))) continue
    const aim = new Vector3(x, lift, z).sub(offset).project(projection)
    if (Math.abs(aim.x) >= .88 || Math.abs(aim.y) >= .86 || Math.abs(predictedLand.x) >= .9 || Math.abs(predictedLand.y) >= .9) continue
    candidates.push({ position: new Vector3(x, lift, z), landHeight: landHit.point.y,
      distance: distance([x, landHit.point.y + bodyRadius, z], edgePose.position) })
  }
  assert.ok(candidates.length, 'the actual dry shore contains a clear edge target whose picking ray misses the original instance bounds')
  candidates.sort((a, b) => a.distance - b.distance)
  const edgeTarget = candidates[0].position
  const projectedTarget = edgeTarget.clone().sub(offset).project(projection)
  const edgePointer = [edgeCanvas.x + (projectedTarget.x + 1) * edgeCanvas.width / 2,
    edgeCanvas.y + (1 - projectedTarget.y) * edgeCanvas.height / 2]
  assert.ok(edgePointer[0] > edgeCanvas.x && edgePointer[0] < edgeCanvas.x + edgeCanvas.width &&
    edgePointer[1] > edgeCanvas.y && edgePointer[1] < edgeCanvas.y + edgeCanvas.height, 'dry-shore target is inside the visible home canvas')
  await page.mouse.move(...edgePointer, { steps: 35 }); await page.waitForTimeout(1300)
  const liftedAtEdge = live(await reserve()).find(piece => piece.id === edgeBody.id)
  assert.ok(liftedAtEdge && Math.hypot(liftedAtEdge.position[0] - edgeTarget.x, liftedAtEdge.position[2] - edgeTarget.z) < .65,
    'held stone reaches the selected dry-shore position')
  await page.mouse.up(); await page.waitForTimeout(1600)
  const edgeSnapshot = await reserve(), atShore = live(edgeSnapshot).find(piece => piece.id === edgeBody.id)
  assert.ok(atShore)
  checkContainer(edgeSnapshot)
  assert.ok(shoreBoundary.clearance(atShore.position[0], atShore.position[2]).distance <= bodyRadius + .65,
    'the released stone remains close to the true land edge')
  assert.ok(lowestModelPoint(atShore) >= activity.waterY - .03, 'the complete released stone remains above water')
  targetRay.setFromCamera(new Vector2((atShore.screen[0] - edgeCanvas.x) / edgeCanvas.width * 2 - 1,
    -(atShore.screen[1] - edgeCanvas.y) / edgeCanvas.height * 2 + 1), projection)
  assert.ok(initialSpheres.every(sphere => !targetRay.ray.intersectsSphere(sphere)),
    'the actual regrab ray is outside every original per-mesh sphere, so stale raycast bounds would fail this regression')
  await capture('06b-stone-at-dry-shore')
  await page.mouse.move(...atShore.screen); await page.mouse.down(); await page.waitForTimeout(100)
  assert.equal((await reserve()).dragging, edgeBody.id, 'the same dry-shore stone can be ray-picked again outside the cached initial pile bounds')
  await page.mouse.up()
  checkMoney(await reserve(), 90_000)
  samples.push({ name: 'dry-shore-stone-regrab', shoreHeight: shoreBoundary.height,
    shoreRadius: { min: shoreBoundary.minRadius, max: shoreBoundary.maxRadius }, waterRadius: activity.waterRadius,
    initialPileRadius: compactRadius, bodyRadius, selectedLandHeight: candidates[0].landHeight,
    initialInstanceBounds: initialSpheres.map(sphere => ({ center: sphere.center.toArray(), radius: sphere.radius })),
    id: edgeBody.id, original: edgeBody.position, target: edgeTarget.toArray(), atShore: atShore.position,
    lowestModelPoint: lowestModelPoint(atShore), screen: atShore.screen })
  checks.push('A stone dragged to the actual dry-land edge remains fully above water and grabbable after settling, outside its initial cached raycast bounds')

  const startCommits = (await reserve()).commits
  const beforeCount = (await ledger()).entries.length
  const clickSamples = []
  let expected = 90_000
  for (let index = 0; index < 12; index++) {
    const direction = index % 2 ? 'expense' : 'income'
    assert.ok(await page.getByTestId(`transaction-${direction}`).isEnabled())
    const started = Date.now()
    await page.getByTestId(`transaction-${direction}`).click()
    expected += direction === 'income' ? 10_000 : -10_000
    await amount(expected)
    const snapshot = await reserve()
    checkMoney(snapshot, expected)
    clickSamples.push({ direction, elapsedMs: Date.now() - started, pending: snapshot.pending, spent: snapshot.spent, commits: snapshot.commits })
    assert.equal(await page.getByLabel('交易金额').inputValue(), '100')
    await page.waitForTimeout(65)
  }
  assert.equal((await ledger()).entries.length, beforeCount + 12)
  assert.equal((await reserve()).commits, startCommits + 12, 'each saved entry is consumed by the scene exactly once')
  assert.ok(clickSamples.filter(sample => sample.pending).length >= 2, 'new entries are accepted while earlier bodies are still moving')
  await idle(); checkMoney(await reserve(), expected)
  await capture('03-continuous-flow')
  samples.push({ name: '12-alternating-clicks', clicks: clickSamples })
  checks.push('Twelve alternating clicks all save and enter the running world immediately; no entry is netted out or replayed')

  await page.getByRole('button', { name: /看进账合成/ }).click()
  await amount(GOLD)
  await page.waitForFunction(goldValue => {
    const pieces = window.__reserveInspect().pieces.filter(piece => !piece.spent)
    return pieces.length === 1 && pieces[0].kind === 'gold' && pieces[0].value === goldValue
  }, GOLD, { timeout: 12000 })
  await idle()
  const merged = await reserve()
  checkMoney(merged, GOLD)
  await capture('04-two-hundred-to-one')
  await page.getByLabel('交易金额').fill('50')
  await page.getByTestId('transaction-expense').click()
  await amount(GOLD - 5000); await idle()
  const split = await reserve()
  checkMoney(split, GOLD - 5000)
  assert.equal(live(split).filter(piece => piece.kind === 'gold').length, 0)
  assert.equal(live(split).filter(piece => piece.kind === 'sand' && piece.value === STONE).length, STONES_PER_GOLD - 1)
  assert.equal(live(split).filter(piece => piece.kind === 'sand' && piece.value === 5000).length, 1)
  await capture('05-two-hundred-way-change')
  checks.push('Two hundred ¥100 stones combine into one ¥20,000 gold; a ¥50 withdrawal leaves 199 full stones and one exact half-value piece')

  await page.waitForTimeout(1000)
  const beforeDragCamera = (await island()).camera
  const grabbed = await grabVisible()
  await page.mouse.move(grabbed.screen[0] + 105, grabbed.screen[1] - 45, { steps: 15 })
  await page.waitForTimeout(180)
  const duringDrag = await reserve()
  assert.ok(duringDrag.dragging)
  const moved = live(duringDrag).find(piece => piece.id === grabbed.id)
  assert.ok(moved && distance(moved.position, grabbed.position) > .15, 'dragging physically moves the chosen body')
  assert.deepEqual((await island()).camera, beforeDragCamera, 'grabbing a stone does not orbit the camera')
  await capture('06-drag-stone')
  await page.mouse.up(); await page.waitForTimeout(500)
  assert.equal(!!(await reserve()).dragging, false)
  checkMoney(await reserve(), GOLD - 5000)
  checks.push('Real pointer grab moves an individual body while holding the camera still; release restores free physical motion without changing money')


  await grabVisible()
  await page.evaluate(() => document.querySelector('canvas').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true })))
  await page.waitForTimeout(100)
  assert.equal(!!(await reserve()).dragging, false, 'pointer cancellation releases the grabbed body')
  await page.mouse.up()
  const beforeOrbit = await reserve(), beforeOrbitCamera = (await island()).camera
  const canvas = await page.locator('canvas').boundingBox()
  const blank = [canvas.x + canvas.width * .08, canvas.y + canvas.height * .22]
  await page.mouse.move(...blank); await page.mouse.down()
  assert.equal(!!(await reserve()).dragging, false, 'the chosen orbit start is empty space')
  await page.mouse.move(blank[0] + 155, blank[1] + 30, { steps: 14 }); await page.mouse.up()
  await page.waitForTimeout(300)
  const afterOrbit = await reserve(), afterOrbitCamera = (await island()).camera
  assert.ok(distance(afterOrbitCamera.position, beforeOrbitCamera.position) > .2, 'empty-space drag orbits the island')
  assert.ok(live(afterOrbit).some(piece => {
    const previous = live(beforeOrbit).find(item => item.id === piece.id)
    return previous && distance(previous.position, piece.position) > .01
  }), 'turning the island gives physical bodies a controlled inertial response')
  checkMoney(afterOrbit, GOLD - 5000)
  checks.push('Pointer cancellation is safe; empty-space dragging turns the camera and nudges the physical pile')

  // Keyboard activation changes preferences without releasing the held mouse
  // first, covering the interruption rather than an ordinary pointer-up.
  await grabVisible()
  await page.getByRole('button', { name: '打开设置', exact: true }).focus(); await page.keyboard.press('Enter')
  await page.getByLabel('减少动态效果', { exact: true }).focus(); await page.keyboard.press('Space')
  assert.equal(await page.getByLabel('减少动态效果', { exact: true }).isChecked(), true)
  await page.waitForTimeout(120)
  assert.equal(!!(await reserve()).dragging, false, 'reducing motion releases an active pointer grab')
  await page.mouse.up()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.waitForTimeout(200)
  const reducedBody = live(await reserve()).find(piece => piece.screen && piece.depth > -1 && piece.depth < 1)
  assert.ok(reducedBody)
  await page.mouse.move(...reducedBody.screen); await page.mouse.down()
  assert.equal(!!(await reserve()).dragging, false, 'reduced-motion mode does not start body dragging')
  await page.mouse.up()
  checkMoney(await reserve(), GOLD - 5000)
  await setReduced(false)
  checks.push('Enabling reduced motion during a held drag safely releases it and prevents new physical grabs')

  await page.getByRole('button', { name: '回到初始视角', exact: true }).click()
  await page.waitForTimeout(1000)
  await grabVisible()
  await page.getByRole('button', { name: '财富尺度', exact: true }).focus(); await page.keyboard.press('Enter')
  await page.getByTestId('camera-status').filter({ hasText: '对比中' }).waitFor()
  assert.equal(!!(await reserve()).dragging, false, 'entering comparison releases a held body')
  await page.mouse.up()
  const frozen = live(await reserve()).map(({ id, position, orientation }) => ({ id, position, orientation }))
  await page.waitForTimeout(300)
  assert.deepEqual(live(await reserve()).map(({ id, position, orientation }) => ({ id, position, orientation })), frozen,
    'the home pile is frozen rather than recreated or simulated during comparison')
  await page.getByRole('button', { name: '回到我的小岛', exact: true }).click()
  await page.getByTestId('camera-status').filter({ hasText: '我的小岛' }).waitFor()
  assert.deepEqual(live(await reserve()).map(piece => piece.id).sort(), frozen.map(piece => piece.id).sort())
  checkMoney(await reserve(), GOLD - 5000)
  checks.push('Comparison cancels an active grab, freezes exact home body poses, and preserves body identities on return')

  // Initializing the isolated personal ledger exercises the maximum balance
  // without filling the real user's storage or requiring a giant animation.
  await page.getByRole('button', { name: '我的账本', exact: true }).click()
  await page.getByLabel('起始余额（元）').fill('1000000')
  await page.getByRole('button', { name: '建立我的小岛' }).click()
  await amount(100_000_000); await page.waitForTimeout(3500)
  const maximum = await reserve()
  checkMoney(maximum, 100_000_000)
  assert.equal(live(maximum).length, DEMO_LIMIT / GOLD)
  assert.ok(live(maximum).every(piece => piece.kind === 'gold'))
  checkContainer(maximum)
  assert.equal((await island()).personal.gold, DEMO_LIMIT / GOLD)
  assert.ok(Math.abs((await island()).personal.goldScale - .45) < 1e-6)
  await capture('07-million-contained')
  samples.push({ name: 'maximum-balance', count: maximum.count, awake: maximum.awake, container: maximum.container,
    shoreRadius: { min: shoreBoundary.minRadius, max: shoreBoundary.maxRadius },
    lowestModelPoint: Math.min(...live(maximum).map(lowestModelPoint)), outsideShore: maximum.outsideShore, belowWater: maximum.belowWater,
    obstacleMeshes: maximum.obstacleMeshes })
  checks.push('Maximum ¥1,000,000 uses 50 fixed-size gold units; every complete model stays above water and within the actual dry-land outline')

  const cameraBeforeComparison = (await island()).camera
  await page.getByRole('button', { name: '财富尺度', exact: true }).click()
  await page.getByTestId('comparison-example-musk').click()
  await page.getByTestId('camera-status').filter({ hasText: '对比中' }).waitFor()
  await capture('08-comparison')
  await page.getByRole('button', { name: '回到我的小岛', exact: true }).click()
  await page.getByTestId('camera-status').filter({ hasText: '我的小岛' }).waitFor()
  assert.deepEqual((await island()).camera, cameraBeforeComparison)
  checks.push('Historical comparison still returns to the exact chosen camera')

  await page.getByRole('button', { name: '先体验', exact: true }).click()
  await amount(GOLD - 5000)
  for (const [width, height] of [[390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(400)
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      actions: [...document.querySelectorAll('.transaction-submit')].map(element => {
        const rect = element.getBoundingClientRect()
        return { width: rect.width, top: rect.top, bottom: rect.bottom }
      }),
    }))
    assert.equal(layout.overflow, false)
    assert.equal(layout.actions.length, 2)
    assert.ok(layout.actions.every(action => action.width >= 120 && action.top >= 0 && action.bottom <= height), JSON.stringify(layout))
    samples.push({ name: 'responsive', width, height, ...layout })
    await capture(`09-mobile-${width}`)
  }
  checks.push('390px and 360px layouts keep both transaction actions visible and have no horizontal overflow')
  assert.deepEqual(errors, [])
  const report = { checkedAt: new Date().toISOString(), browserCheckDurationMs: Date.now() - checkStartedAt,
    base, browser: browser.version(), assetHashes, servedAssetsMatch: true, checks, samples, errors,
    recording: false, phone: 'Browser viewport emulation, not a physical phone' }
  await writeFile('docs/playable-browser-check.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
