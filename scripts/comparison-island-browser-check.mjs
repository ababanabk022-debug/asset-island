import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { COMPARISON_PLACEMENT_SOURCE, COMPARISON_PLACEMENTS } from '../src/scene/comparisonPlacements.ts'

const base = process.env.TEST_URL || 'http://127.0.0.1:5186'
const output = 'docs/comparison-island-0.9.0'
const examples = [
  { id: '10k', amount: 1_000_000, gold: 0, sand: 100 },
  { id: '100k', amount: 10_000_000, gold: 5, sand: 0 },
  { id: '1m', amount: 100_000_000, gold: 50, sand: 0 },
  { id: 'musk', amount: 580_822_920_000_000, gold: 290_411_460, sand: 0 },
]
const assetHashes = Object.fromEntries(await Promise.all(
  ['island-study.glb', 'gold.glb', 'sandstone.glb', 'island-collision.bin'].map(async file =>
    [file, createHash('sha256').update(await readFile(`assets/runtime/${file}`)).digest('hex')]),
))
const sourceHashes = Object.fromEntries(await Promise.all(
  ['ComparisonReserve.tsx', 'ComparisonTerrain.tsx', 'comparisonPlacements.ts'].map(async file =>
    [file, createHash('sha256').update(await readFile(`src/scene/${file}`)).digest('hex')]),
))
await mkdir(output, { recursive: true })
const startedAt = Date.now()
const checks = [], errors = [], consoleErrors = [], snapshots = [], resourceSamples = [], animationChecks = []
let failure
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' })
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
const inspect = () => page.evaluate(() => window.__islandInspect())
const reserve = () => page.evaluate(() => window.__reserveInspect())
const motion = () => page.evaluate(() => window.__comparisonMotionInspect())
const currentLedger = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('time-island-rebuild:reserve-demo:v1')))
const live = snapshot => snapshot.pieces.filter(piece => !piece.spent)
const ids = snapshot => live(snapshot).map(piece => piece.id).sort()
const poses = snapshot => live(snapshot).map(({ id, position, orientation }) => ({ id, position, orientation }))
const sameVector = (actual, expected, name) => {
  assert.equal(actual.length, expected.length, name)
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6,
    `${name}: ${JSON.stringify({ actual, expected })}`))
}
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const fontsReady = () => page.evaluate(async () => { await document.fonts.ready })
const screenshot = name => page.screenshot({ path: `${output}/${name}.png`, fullPage: true })
async function arrive(comparing, skip = false) {
  if (skip) {
    const shortcut = page.getByRole('button', { name: '直接到达', exact: true })
    if (await shortcut.isVisible()) await shortcut.click()
  }
  await page.getByTestId('camera-status').filter({ hasText: comparing ? '对比中' : '我的小岛' }).waitFor({ timeout: 15000 })
  await frame()
  assert.equal((await inspect()).comparison.transitioning, false, 'The camera has completed its transition')
}
async function enter(skip = false) {
  await page.getByRole('button', { name: '财富尺度', exact: true }).click()
  await arrive(true, skip)
}
async function select(id, skip = false) {
  await page.getByTestId(`comparison-example-${id}`).click()
  await arrive(true, skip)
  await fontsReady()
}
async function back(skip = false) {
  await page.getByRole('button', { name: '回到我的小岛', exact: true }).click()
  await arrive(false, skip)
}
function checkFinalPoses(snapshot, example) {
  assert.equal(snapshot.dropRunning, false, `${example.id}: presentation motion has finished`)
  assert.equal(snapshot.dropProgress, 1)
  for (const instances of snapshot.instances) {
    const expected = COMPARISON_PLACEMENTS[example.id]?.filter(piece => piece.kind === instances.kind) ?? []
    assert.equal(instances.count, expected.length)
    expected.forEach((piece, index) => {
      const exact = new Matrix4().compose(new Vector3(...piece.position), new Quaternion(...piece.orientation), new Vector3(.45, .45, .45))
      sameVector(instances.matrices[index], exact.toArray(), `${example.id}: ${instances.kind} ${index} ends at the exact baked pose`)
    })
  }
}
async function captureMotion(action, example, label, expectDrop) {
  // Numeric matrix sampling only; no screen recording and no runtime mutation.
  await page.evaluate(() => {
    window.__comparisonQaFrames = []
    const token = {}
    window.__comparisonQaRunning = token
    const sample = () => {
      if (window.__comparisonQaRunning !== token) return
      const motion = window.__comparisonMotionInspect()
      window.__comparisonQaFrames.push({
        at: performance.now(), amount: motion.amount, visible: motion.visible, active: motion.active,
        transitioning: motion.transitioning, running: motion.dropRunning, progress: motion.dropProgress,
        skipped: motion.dropSkipped,
        countText: document.querySelector('[data-testid="comparison-count"]')?.textContent ?? '',
        amountText: document.querySelector('[data-testid="comparison-amount"]')?.textContent ?? '',
        instances: motion.instances.map(part => ({
          kind: part.kind, count: part.count, visible: part.visible,
          positions: part.matrices.map(matrix => [matrix[12], matrix[13], matrix[14]]),
        })),
      })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await action()
  await page.waitForFunction(() => {
    const snapshot = window.__comparisonMotionInspect()
    return !snapshot.transitioning && snapshot.dropRunning === false && snapshot.dropProgress === 1
  }, null, { timeout: 15000 })
  await frame()
  const samples = await page.evaluate(() => {
    window.__comparisonQaRunning = false
    const samples = window.__comparisonQaFrames
    delete window.__comparisonQaFrames; delete window.__comparisonQaRunning
    return samples
  })
  const relevant = samples.filter(sample => sample.amount === example.amount && sample.active && sample.visible)
  assert.ok(relevant.length > 0, `${label}: actual frames were sampled`)
  for (const sample of relevant) {
    const gold = sample.instances.find(part => part.kind === 'gold')?.count ?? 0
    const sand = sample.instances.find(part => part.kind === 'sand')?.count ?? 0
    assert.equal(gold, example.id === 'musk' ? 0 : example.gold, `${label}: every frame retains the gold instance count`)
    assert.equal(sand, example.sand, `${label}: every frame retains the sandstone instance count`)
    if (example.id !== 'musk') {
      assert.equal(gold * 2_000_000 + sand * 10_000, example.amount, `${label}: no amount is lost during falling`)
      assert.equal(sample.amountText.replace(/[¥,\s]/g, ''), String(example.amount / 100))
    }
    assert.match(sample.countText.replace(/[,，]/g, ''), example.sand ? /100\s*块砂岩/ : new RegExp(`${example.gold}\\s*块金矿`))
    if (sample.transitioning) assert.equal(sample.running, false, `${label}: falling waits until the camera has arrived`)
  }
  const falling = relevant.filter(sample => sample.running)
  if (expectDrop) {
    assert.ok(falling.length >= 3, `${label}: the fall is visible across multiple rendered frames`)
    assert.ok(falling[0].progress < .4, `${label}: capture includes the beginning of the actual fall`)
    const later = falling.find(sample => sample.progress >= .55 && sample.progress <= .85)
    assert.ok(later, `${label}: capture includes the later fall`)
    for (const first of falling[0].instances.filter(part => part.count)) {
      const target = COMPARISON_PLACEMENTS[example.id].filter(piece => piece.kind === first.kind)
      const moved = later.instances.find(part => part.kind === first.kind)
      assert.ok(first.visible && moved?.visible, `${label}: the whole batch is visible while falling`)
      first.positions.forEach((position, index) => {
        assert.ok(position[1] > target[index].position[1] + .5, `${label}: every piece starts above its final pose`)
        assert.ok(position[1] - moved.positions[index][1] > .3, `${label}: every piece descends in the same short batch`)
        for (const axis of [0, 2]) assert.ok(Math.abs(position[axis] - target[index].position[axis]) < 1e-6,
          `${label}: vertical presentation retains the baked horizontal placement`)
      })
    }
  } else assert.equal(falling.length, 0, `${label}: the entry animation is skipped`)
  const final = await motion()
  checkFinalPoses(final, example)
  animationChecks.push({ label, example: example.id, sampledFrames: relevant.length, fallingFrames: falling.length,
    fallDurationMs: falling.length ? falling.at(-1).at - falling[0].at : 0,
    firstProgress: falling[0]?.progress ?? null, lastProgress: falling.at(-1)?.progress ?? null,
    finalSkipped: final.dropSkipped, count: example.gold + example.sand,
    frameSummary: relevant.map(sample => ({ at: sample.at, transitioning: sample.transitioning,
      running: sample.running, progress: sample.progress,
      gold: sample.instances.find(part => part.kind === 'gold')?.count ?? 0,
      sand: sample.instances.find(part => part.kind === 'sand')?.count ?? 0,
      firstY: sample.instances.find(part => part.count)?.positions[0]?.[1] ?? null })) })
}
function checkPersonal(snapshot, originalIds) {
  assert.equal(snapshot.amount, 80_000, 'Comparing never changes the committed personal balance')
  assert.equal(snapshot.represented, 80_000)
  assert.equal(snapshot.count, 8, 'Comparing does not create additional personal physics bodies')
  assert.deepEqual(ids(snapshot), originalIds, 'The original personal physics body identities are retained')
  assert.equal(snapshot.outsideShore, 0)
  assert.equal(snapshot.belowWater, 0)
}
function checkSameIsland(snapshot, id) {
  const environment = snapshot.comparison.environment
  assert.ok(environment?.visible, `${id}: ordinary comparison environment is visible`)
  assert.equal(environment.source, '/generated/island-study.glb')
  assert.equal(environment.sameAsPersonal, true)
  assert.equal(environment.staticPlacements, true)
  assert.equal(environment.physicsRuntime, false)
  sameVector(environment.worldScale, [1, 1, 1], `${id}: the island itself remains full scale`)
  const personalLand = snapshot.islands.terrainMeshes.filter(mesh => mesh.role === 'personal')
  const comparisonLand = snapshot.islands.terrainMeshes.filter(mesh => mesh.role === 'comparison' && mesh.visible)
  assert.equal(personalLand.length, 1, `${id}: one authored personal terrain`)
  assert.equal(comparisonLand.length, 1, `${id}: one matching authored comparison terrain`)
  const own = personalLand[0], compared = comparisonLand[0]
  assert.ok(own.visible && compared.visible, `${id}: both actual terrain meshes are visible`)
  assert.equal(compared.geometryFingerprint, own.geometryFingerprint, `${id}: actual terrain vertices and indices match`)
  assert.equal(compared.triangles, own.triangles)
  sameVector(compared.relativeMatrix, own.relativeMatrix, `${id}: terrain transforms are identical relative to each island`)
  sameVector(compared.boundsMin, own.boundsMin, `${id}: matching land minimum`)
  sameVector(compared.boundsMax, own.boundsMax, `${id}: matching land maximum`)
  const containers = snapshot.islands.containers
  const ownWater = containers.find(container => container.role === 'personal')
  const comparedWater = containers.find(container => container.role === 'comparison' && container.visible)
  assert.ok(ownWater?.surface && comparedWater?.surface, `${id}: both actual water surfaces exist`)
  for (const container of [ownWater, comparedWater]) {
    assert.equal(container.waterRadius, 7.4)
    assert.equal(container.waterRadiusX, 7.4)
    assert.equal(container.waterRadiusZ, 7.4)
    assert.ok(container.visible && container.surface.visible)
    sameVector(container.worldScale, [1, 1, 1], `${id}: water is not enlarged`)
  }
  assert.equal(comparedWater.surface.geometryFingerprint, ownWater.surface.geometryFingerprint)
  sameVector(comparedWater.surface.boundsMin, ownWater.surface.boundsMin, `${id}: matching water minimum`)
  sameVector(comparedWater.surface.boundsMax, ownWater.surface.boundsMax, `${id}: matching water maximum`)
  for (const name of ['Island living details', 'Feather palm crowns']) {
    const ownDetail = snapshot.islands.details.find(detail => detail.role === 'personal' && detail.name === name)
    const comparedDetail = snapshot.islands.details.find(detail => detail.role === 'comparison' && detail.name === name && detail.visible)
    assert.ok(ownDetail?.meshes > 0 && comparedDetail?.visible, `${id}: shared ${name} is present`)
    assert.equal(comparedDetail.meshes, ownDetail.meshes, `${id}: matching detail geometry population`)
  }
  for (const mesh of [compared, comparedWater.surface]) {
    assert.ok(mesh.projected.every(([x, y, z]) => Math.abs(x) <= 1.01 && Math.abs(y) <= 1.01 && Math.abs(z) <= 1),
      `${id}: land and water bounds fit the actual camera frustum`)
  }
}
async function checkExample(example, label, originalIds, frozen) {
  await page.waitForFunction(() => window.__comparisonMotionInspect().dropRunning === false, null, { timeout: 15000 })
  await frame()
  const snapshot = await inspect(), physical = await reserve()
  checkPersonal(physical, originalIds)
  assert.deepEqual(poses(physical), frozen, `${label}: comparison does not simulate or rebuild the personal pile`)
  assert.equal(snapshot.comparison.active, true)
  if (example.id === 'musk') {
    assert.equal(snapshot.comparison.far, true)
    assert.equal(snapshot.comparison.actualInstances, 0)
    assert.equal(snapshot.comparison.actualSandInstances, 0)
    const envelopes = snapshot.comparison.envelopes.filter(envelope => envelope.visible)
    assert.equal(envelopes.length, 1, 'One visible exterior envelope represents the historical estimate')
    assert.equal(envelopes[0].representedCount, example.gold)
    assert.equal(envelopes[0].representedCount * 2_000_000, example.amount)
    assert.ok(envelopes[0].exteriorOnly && envelopes[0].triangles < 100_000)
    sameVector(envelopes[0].worldScale, [1, 1, 1], 'The exterior envelope is not geometrically enlarged')
    assert.match(await page.getByTestId('comparison-amount').innerText(), /约\s*5\.81\s*万亿/)
  } else {
    assert.equal(snapshot.comparison.far, false)
    assert.equal(snapshot.comparison.actualInstances, example.gold, `${label}: actual gold instance count`)
    assert.equal(snapshot.comparison.actualSandInstances, example.sand, `${label}: actual sandstone instance count`)
    assert.equal(snapshot.comparison.actualInstances * 2_000_000 + snapshot.comparison.actualSandInstances * 10_000, example.amount,
      `${label}: actual visible denominations conserve the displayed amount`)
    for (const mesh of snapshot.comparison.instances) {
      const expected = mesh.kind === 'gold' ? example.gold : example.sand
      assert.equal(mesh.count, expected, `${label}: every model material part has the correct instance population`)
      if (!expected) continue
      assert.ok(mesh.visible)
      sameVector(mesh.worldScaleMin, [.45, .45, .45], `${label}: smallest instance retains the personal unit scale`)
      sameVector(mesh.worldScaleMax, [.45, .45, .45], `${label}: largest instance retains the personal unit scale`)
    }
    checkSameIsland(snapshot, label)
    const displayed = (await page.getByTestId('comparison-amount').innerText()).replace(/[¥,\s]/g, '')
    assert.equal(displayed, String(example.amount / 100))
  }
  const countText = (await page.getByTestId('comparison-count').innerText()).replace(/[,，]/g, '')
  assert.match(countText, example.sand ? /100\s*块砂岩/ : new RegExp(`${example.gold}\\s*块金矿`))
  assert.doesNotMatch(await page.getByTestId('comparison-panel').innerText(), /金矿\s*¥5,000|50\s*块砂岩|50\s*[∶:]\s*1/,
    'The comparison panel does not retain the old gold denomination')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `${label}: no horizontal page overflow`)
  snapshots.push({ label, ...snapshot, personalPhysics: { amount: physical.amount, count: physical.count, ids: ids(physical) },
    countText, displayedAmount: await page.getByTestId('comparison-amount').innerText() })
  return snapshot
}
try {
  assert.deepEqual(COMPARISON_PLACEMENT_SOURCE.sourceAssets, assetHashes, 'Baked placements are tied to the currently served models and collision proxy')
  assert.equal(COMPARISON_PLACEMENT_SOURCE.goldFen, 2_000_000)
  assert.equal(COMPARISON_PLACEMENT_SOURCE.sandFen, 10_000)
  assert.equal(COMPARISON_PLACEMENT_SOURCE.stonesPerGold, 200)
  assert.equal(COMPARISON_PLACEMENT_SOURCE.modelScale, .45)
  for (const example of examples.filter(example => example.id !== 'musk')) {
    const pieces = COMPARISON_PLACEMENTS[example.id]
    assert.equal(pieces.filter(piece => piece.kind === 'gold').length, example.gold)
    assert.equal(pieces.filter(piece => piece.kind === 'sand').length, example.sand)
    assert.equal(pieces.reduce((sum, piece) => sum + piece.value, 0), example.amount)
  }
  const comparisonSource = await readFile('src/scene/ComparisonReserve.tsx', 'utf8')
  assert.match(comparisonSource, /COMPARISON_PLACEMENTS/, 'Ordinary comparison poses use the baked static source')
  for (const file of ['ComparisonReserve.tsx', 'ComparisonTerrain.tsx']) {
    assert.doesNotMatch(await readFile(`src/scene/${file}`, 'utf8'), /FreeReservePhysics|@dimforge\/rapier/,
      `${file} creates no extra comparison physics simulation`)
  }
  await page.goto(base)
  await page.getByText('三维小岛加载完成', { exact: true }).waitFor({ timeout: 30000 })
  await fontsReady()
  for (const [file, hash] of Object.entries(assetHashes)) {
    const response = await page.request.get(`${base}/generated/${file}`)
    assert.ok(response.ok())
    assert.equal(createHash('sha256').update(await response.body()).digest('hex'), hash, `Served ${file} matches the test source`)
  }
  await page.getByRole('button', { name: '背面', exact: true }).click()
  await page.waitForTimeout(1000)
  await frame()
  const before = await reserve(), originalIds = ids(before), originalLedger = await currentLedger()
  checkPersonal(before, originalIds)
  const savedCamera = (await inspect()).camera
  await captureMotion(() => enter(), examples[0], 'first-entry-10k', true)
  const frozen = poses(await reserve())
  let ordinaryCamera
  for (const [index, example] of examples.entries()) {
    if (index) await captureMotion(() => select(example.id), example, `desktop-entry-${example.id}`, example.id !== 'musk')
    const snapshot = await checkExample(example, `desktop-${example.id}`, originalIds, frozen)
    if (example.id !== 'musk') {
      if (ordinaryCamera) assert.deepEqual(snapshot.camera, ordinaryCamera, 'Ordinary amounts use identical camera framing and island size')
      else ordinaryCamera = snapshot.camera
    }
    await screenshot(`01-${example.id}-desktop`)
  }
  await back()
  assert.deepEqual((await inspect()).camera, savedCamera, 'All four examples return to the exact chosen position, target and clipping planes')
  checkPersonal(await reserve(), originalIds)
  checks.push('Ordinary examples contain 100 sandstone, 5 gold and 50 gold at unchanged .45 world scale; their actual land, water and details match the personal island')
  checks.push('The historical estimate is exactly 290,411,460 gold units in one exterior envelope; all four denominations and amount labels agree')
  checks.push('Switching all four examples freezes original personal body poses and preserves IDs, balance and the exact chosen home camera')

  await enter(true)
  await captureMotion(() => select('10k', true), examples[0], 'replay-preparation-10k', true)
  await back(true)
  await captureMotion(() => enter(true), examples[0], 'repeated-entry-10k', true)
  await back(true)
  assert.deepEqual((await inspect()).camera, savedCamera, 'Repeated animated entry still restores the exact personal camera')

  // Warm all mounted resources once before measuring identical return states.
  await enter(true)
  for (const example of examples) await select(example.id, true)
  await back(true)
  const warm = (await inspect()).renderer
  for (let index = 0; index < 12; index++) {
    await enter(true)
    await select(examples[index % examples.length].id, true)
    await back(true)
    const snapshot = await inspect()
    assert.deepEqual(snapshot.camera, savedCamera, `Repeated round trip ${index + 1} restores the same camera`)
    checkPersonal(await reserve(), originalIds)
    assert.ok(snapshot.renderer.geometries <= warm.geometries, `Geometry count grows after warmup: ${JSON.stringify({ warm, now: snapshot.renderer })}`)
    assert.ok(snapshot.renderer.textures <= warm.textures, `Texture count grows after warmup: ${JSON.stringify({ warm, now: snapshot.renderer })}`)
    resourceSamples.push({ cycle: index + 1, example: examples[index % examples.length].id,
      geometries: snapshot.renderer.geometries, textures: snapshot.renderer.textures })
  }
  checks.push('Twelve warmed four-example round trips preserve the camera and physics population without increasing renderer geometry or texture counts')

  for (const [width, height] of [[390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height })
    await fontsReady(); await frame()
    const mobileSaved = (await inspect()).camera
    await enter()
    const mobileFrozen = poses(await reserve())
    for (const example of examples) {
      await select(example.id, true)
      await checkExample(example, `mobile-${width}-${example.id}`, originalIds, mobileFrozen)
      const panel = await page.getByTestId('comparison-panel').boundingBox()
      assert.ok(panel && panel.x >= 0 && panel.x + panel.width <= width + 1, 'Mobile comparison panel fits the viewport')
      if (width === 360 && ['10k', 'musk'].includes(example.id)) await screenshot(`02-${example.id}-mobile-360`)
    }
    await back(true)
    assert.deepEqual((await inspect()).camera, mobileSaved, `${width}px return preserves the camera`)
    checkPersonal(await reserve(), originalIds)
  }
  checks.push('All four examples work at 390px and 360px; matching land and water stay visible and the panel never overflows horizontally')
  // Motion-preference changes intentionally resync the personal physics. Run
  // that lifecycle after the unchanged-ID checks for ordinary comparison use.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await frame()
  await enter()
  await captureMotion(() => select('10k'), examples[0], 'reduced-entry-10k', false)
  for (const example of examples.slice(1)) {
    await captureMotion(() => select(example.id), example, `reduced-entry-${example.id}`, false)
  }
  await back(true)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await frame()
  await enter(true)
  await select('100k', true)
  assert.equal((await motion()).dropRunning, true, 'Background handling is tested during a real active fall')
  try {
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const hidden = await motion()
    checkFinalPoses(hidden, examples[1])
    assert.equal(hidden.dropSkipped, 'background')
    animationChecks.push({ label: 'background-finishes-active-fall', count: 5, finalSkipped: hidden.dropSkipped,
      method: 'Synthetic document.hidden plus visibilitychange exercises the actual page lifecycle handlers.' })
  } finally {
    await page.evaluate(() => {
      delete document.hidden
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }
  await back(true)
  const afterLifecycle = await reserve()
  assert.equal(afterLifecycle.amount, 80_000)
  assert.equal(afterLifecycle.represented, 80_000)
  assert.equal(afterLifecycle.count, 8)
  checks.push('Every ordinary piece drops only after arrival, preserves its value each sampled frame and ends at its exact baked matrix; entry replays, reduced motion skips, background finishes, and Musk allocates no dynamic pile')
  assert.deepEqual(await currentLedger(), originalLedger, 'Comparison makes no changes to the isolated saved ledger')
  assert.deepEqual(errors, [])
  assert.deepEqual(consoleErrors, [])
} catch (error) {
  failure = { message: error.message, stack: error.stack }
  await screenshot('failure').catch(() => {})
} finally {
  const report = {
    checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, base, browser: browser.version(),
    passed: !failure, assetHashes, sourceHashes, placementSource: COMPARISON_PLACEMENT_SOURCE,
    checks, snapshots, resourceSamples, animationChecks, errors, consoleErrors,
    ...(failure ? { failure } : {}), recording: false,
    limitations: [
      'Fresh isolated Chrome context with synthetic demo data; no personal user ledger or tabs.',
      'Renderer resource counts do not prove absence of every JavaScript or GPU memory leak.',
      'Narrow viewport emulation is not a physical phone test; no performance benchmark is claimed.',
    ],
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, checks, snapshots: snapshots.length, resourceSamples,
    animationChecks: animationChecks.map(check => ({ ...check, frameSummary: undefined })),
    errors, consoleErrors, failure, durationMs: report.durationMs }, null, 2))
  await browser.close()
}
if (failure) process.exitCode = 1
