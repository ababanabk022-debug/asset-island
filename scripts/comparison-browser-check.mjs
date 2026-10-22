import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

// Independent fresh browser context: never reads or changes a user's browser profile.
// No video recording. Inspect hook is read-only and must only exist in development.
const origin = 'http://127.0.0.1:5186/'
const output = 'docs/comparison-screenshots'
const desktop = { width: 1440, height: 1000 }
const examples = ['10k', '100k', '1m', 'musk']
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: desktop, deviceScaleFactor: 1, reducedMotion: 'no-preference' })
page.setDefaultTimeout(15000)
const errors = [], checks = [], resourceSamples = [], performanceSamples = [], exampleSnapshots = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
const inspect = () => page.evaluate(() => window.__islandInspect())
const status = () => page.getByTestId('camera-status')
const enter = () => page.getByRole('button', { name: '看看财富量级', exact: true }).click()
const back = () => page.getByRole('button', { name: '回到我的小岛', exact: true }).click()
const amount = async () => Number((await page.getByTestId('balance').textContent()).replace(/[^\d.]/g, ''))
const settleFrames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const waitCameraRest = () => page.evaluate(async () => {
  let previous = window.__islandInspect().camera.position, stable = 0
  const deadline = performance.now() + 20000
  while (performance.now() < deadline) {
    await new Promise(resolve => requestAnimationFrame(resolve))
    const next = window.__islandInspect().camera.position
    stable = next.every((value, i) => Math.abs(value - previous[i]) < 1e-8) ? stable + 1 : 0
    if (stable >= 6) return
    previous = next
  }
  throw new Error('Camera damping did not settle before capturing the test viewpoint')
})
async function settled(active) {
  await page.waitForFunction(expected => {
    const state = window.__islandInspect?.()
    return state && state.comparison.active === expected && !state.comparison.transitioning
  }, active)
  await settleFrames()
  assert.match(await status().innerText(), active ? /对比中/ : /我的小岛/)
}
async function arrive() {
  const skip = page.getByRole('button', { name: '直接到达', exact: true })
  await skip.waitFor({ state: 'visible' })
  await skip.click()
  await settled(true)
}
function sameCamera(actual, expected, label) {
  for (const component of ['position', 'target']) {
    assert.equal(actual[component].length, 3)
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[component][i] - expected[component][i]) < 0.0001,
      `${label}: ${component}[${i}] ${actual[component][i]} != ${expected[component][i]}`)
  }
  assert.ok(Math.abs(actual.near - expected.near) < 0.0001, `${label}: near clip changed`)
  assert.ok(Math.abs(actual.far - expected.far) < 0.0001, `${label}: far clip changed`)
}
async function selectExample(id) {
  await page.getByTestId(`comparison-example-${id}`).click()
  await settled(true)
  const panel = await page.getByTestId('comparison-panel').innerText()
  assert.doesNotMatch(panel, /Infinity|NaN|undefined/)
  const state = (await inspect()).comparison
  const expectedCount = { '10k': 10, '100k': 100, '1m': 1000, musk: 5808229200 }[id]
  assert.equal(state.count, expectedCount, `${id}: exact represented count`)
  assert.match(await page.getByTestId('comparison-count').innerText(), new RegExp(expectedCount.toLocaleString('en-US')))
  if (id === 'musk') {
    assert.match(panel, /历史估值/)
    assert.match(await page.getByTestId('comparison-amount').innerText(), /约\s*5\.81\s*万亿/)
    assert.equal(state.far, true)
    assert.equal(state.layers, 2323)
    assert.equal(state.actualInstances, 0, 'Historical panorama must not allocate billions of instances')
    const sources = await page.locator('.comparison-source-note').textContent()
    assert.match(sources, /2026-03-01/)
    assert.match(sources, /2026-02-27/)
    assert.match(sources, /6\.9228/)
    assert.match(sources, /非今日实时估值/)
    assert.match(sources, /并非可消费的现金/)
    assert.match(await page.getByRole('link', { name: 'Forbes 2026 榜单', includeHidden: true }).getAttribute('href'), /^https:\/\/www\.forbes\.com\.au\//)
    assert.match(await page.getByRole('link', { name: '2026-02-27 汇率中间价公告', includeHidden: true }).getAttribute('href'), /^https:\/\//)
  } else {
    assert.match(panel, /数量示例/)
    assert.equal(state.actualInstances, expectedCount, `${id}: rendered instance count must equal the declared quantity`)
    assert.ok(Math.abs(state.actualUnitScale - .45) < 1e-6, `${id}: actual instance matrix must keep .45 model size`)
    assert.deepEqual(state.islandRadii, [15, 13], `${id}: same fixed example island`)
    assert.equal(state.far, false)
    assert.ok(Number.isSafeInteger(state.layers) && state.layers > 0)
  }
  return panel
}
async function samplePerformance(label, quality) {
  // These are recent browser-frame observations, not a target-device benchmark.
  await page.waitForTimeout(1200)
  const state = await inspect()
  const times = state.frameMs.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  assert.ok(times.length > 0, 'Read-only frame sample must contain actual frame times')
  const percentile = p => times[Math.min(times.length - 1, Math.floor((times.length - 1) * p))]
  performanceSamples.push({ label, quality, viewport: page.viewportSize(), samples: times.length,
    p50ms: percentile(.5), p95ms: percentile(.95), renderer: state.renderer })
}
async function submit(type, value) {
  await page.getByRole('button', { name: type === 'income' ? '进账' : '出账', exact: true }).click()
  await page.getByRole('textbox', { name: '交易金额' }).fill(value)
  await page.getByRole('button', { name: type === 'income' ? /记入进账/ : /确认出账/ }).click()
}
async function simulatedVisibility(hidden) {
  await page.evaluate(value => {
    if (value) Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    else delete document.hidden
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}
try {
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.getByText('三维小岛加载完成', { exact: true }).waitFor()
  await page.waitForFunction(() => typeof window.__islandInspect === 'function')
  await settled(false)
  assert.equal(await amount(), 800)
  const original = (await inspect()).camera
  const box = await page.locator('canvas').boundingBox()
  assert.ok(box)
  const dragX = box.x + box.width * .58, dragY = box.y + box.height * .65
  await page.mouse.move(dragX, dragY)
  await page.mouse.down()
  await page.mouse.move(dragX + 110, dragY - 32, { steps: 12 })
  await page.mouse.up()
  await page.mouse.wheel(0, -180)
  await waitCameraRest() // Frame-based damping can outlast one wall-clock second on headless hardware.
  const saved = (await inspect()).camera
  assert.ok(saved.position.some((value, i) => Math.abs(value - original.position[i]) > .01), 'Drag and wheel must change the camera')
  await enter()
  await settled(true)
  let commonExampleCamera
  for (const id of examples) {
    await selectExample(id)
    const snapshot = await inspect()
    exampleSnapshots.push({ id, ...snapshot.comparison, camera: snapshot.camera, renderer: snapshot.renderer })
    if (id !== 'musk') {
      if (commonExampleCamera) sameCamera(snapshot.camera, commonExampleCamera, `${id}: fixed comparison-camera framing`)
      else commonExampleCamera = snapshot.camera
    }
    await page.screenshot({ path: `${output}/quantity-${id}-desktop.png`, fullPage: true })
  }
  const sourceDetails = page.locator('.comparison-source-note details')
  await sourceDetails.locator('summary').click()
  assert.equal(await sourceDetails.getAttribute('open'), '')
  await page.screenshot({ path: `${output}/quantity-musk-sources.png`, fullPage: true })
  await sourceDetails.locator('summary').click()
  assert.equal(await page.locator('.transaction-form button[type=submit]').isDisabled(), true)
  await page.screenshot({ path: `${output}/01-comparison-desktop.png`, fullPage: true })
  await samplePerformance('Historical Musk quantity panorama', 'high')
  await back()
  await settled(false)
  sameCamera((await inspect()).camera, saved, 'Orbit/zoom restoration')
  checks.push('10/100/1000 actual gold instances retain .45 scale, fixed island footprint and identical camera framing; historical snapshot has exact 5808229200 count in 2323 bounded layers')
  checks.push('Historical estimate shows dates, sources and net-worth limitations instead of claiming a live quote')
  checks.push('Dragged and zoomed camera restores position, target and clipping after all four comparisons; comparison blocks transactions')

  await page.setViewportSize({ width: 1180, height: 820 })
  await settleFrames()
  sameCamera((await inspect()).camera, saved, 'Resize retains home camera')
  await enter(); await arrive()
  await page.setViewportSize(desktop)
  await back(); await settled(false)
  sameCamera((await inspect()).camera, saved, 'Resize while comparing retains saved home camera')
  checks.push('Resize before and during comparison does not reset the saved home viewpoint')

  await enter()
  await status().filter({ hasText: '拉远中' }).waitFor()
  await back(); await settled(false)
  sameCamera((await inspect()).camera, saved, 'Return while moving outward')
  await enter(); await arrive()
  await back(); await settled(false)
  sameCamera((await inspect()).camera, saved, 'Skip arrival then return')
  checks.push('Mid-transition return and Direct Arrival both end coherently and restore the camera')

  await enter()
  await page.getByTestId('comparison-example-100k').click()
  await page.getByTestId('comparison-example-musk').click()
  await arrive()
  assert.match(await page.getByTestId('comparison-amount').innerText(), /约\s*5\.81\s*万亿/)
  assert.equal((await inspect()).comparison.count, 5808229200)
  await back()
  await page.getByRole('button', { name: '直接到达', exact: true }).click()
  await settled(false)
  sameCamera((await inspect()).camera, saved, 'Latest example wins and return skip restores home')
  checks.push('Changing examples mid-flight keeps the latest choice; skipping the return restores home')

  await enter()
  await status().filter({ hasText: '拉远中' }).waitFor()
  await simulatedVisibility(true)
  // Background rendering is paused, so do not await requestAnimationFrame here.
  await page.waitForFunction(() => !window.__islandInspect().comparison.transitioning)
  assert.match(await status().innerText(), /对比中/)
  await simulatedVisibility(false)
  await back()
  await status().filter({ hasText: '返回中' }).waitFor()
  await simulatedVisibility(true)
  await page.waitForFunction(() => !window.__islandInspect().comparison.transitioning)
  assert.match(await status().innerText(), /我的小岛/)
  await simulatedVisibility(false)
  await settled(false)
  sameCamera((await inspect()).camera, saved, 'Visibility cancellation restores home')
  checks.push('Simulated hidden-document events settle both outbound and returning transitions without a stuck state')

  await page.getByLabel('减少动态效果', { exact: true }).check()
  await enter(); await settleFrames()
  assert.equal((await inspect()).comparison.transitioning, false, 'Reduced motion must not run the camera transition')
  await settled(true); await back(); await settleFrames()
  assert.equal((await inspect()).comparison.transitioning, false)
  await settled(false)
  sameCamera((await inspect()).camera, saved, 'Reduced-motion return')
  checks.push('Reduced motion enters and returns directly')

  // Warm every example before measuring persistent resource counts at the same home state.
  const warm = { geometries: 0, textures: 0 }
  for (const id of examples) {
    await enter(); await selectExample(id); await back(); await settled(false)
    const renderer = (await inspect()).renderer
    warm.geometries = Math.max(warm.geometries, renderer.geometries)
    warm.textures = Math.max(warm.textures, renderer.textures)
  }
  for (let i = 0; i < 20; i++) {
    await enter(); await selectExample(examples[i % examples.length]); await back(); await settled(false)
    const state = await inspect()
    sameCamera(state.camera, saved, `Round trip ${i + 1}`)
    resourceSamples.push({ cycle: i + 1, example: examples[i % examples.length], geometries: state.renderer.geometries, textures: state.renderer.textures })
  }
  for (const sample of resourceSamples) {
    assert.ok(sample.geometries <= warm.geometries + 1, `Geometry growth after warmup: ${JSON.stringify({ warm, sample })}`)
    assert.ok(sample.textures <= warm.textures + 1, `Texture growth after warmup: ${JSON.stringify({ warm, sample })}`)
  }
  checks.push('20 warmed round trips restore the camera without accumulating geometries or textures')

  for (let i = 0; i < 10; i++) { await submit('income', '1'); assert.equal(await amount(), 801 + i) }
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText('三维小岛加载完成', { exact: true }).waitFor()
  assert.equal(await amount(), 810)
  checks.push('10 distinct transactions persist exactly once through comparison use and reload')
  await page.getByRole('button', { name: /看进账合成/ }).click()
  assert.equal(await amount(), 1000)
  await page.getByRole('button', { name: '跳过动画', exact: true }).waitFor()
  await enter(); await arrive()
  await page.getByRole('button', { name: '跳过动画', exact: true }).waitFor({ state: 'detached' })
  assert.equal(await amount(), 1000)
  await back(); await settled(false)
  assert.match(await page.getByTestId('reserve-counts').innerText(), /金矿\s*1/)
  checks.push('Entering comparison during a transaction settles its already committed balance and reserve')

  await page.getByLabel('减少动态效果', { exact: true }).check()
  await submit('expense', '1000')
  assert.equal(await amount(), 0)
  await enter(); await settled(true)
  const zero = await selectExample('musk')
  assert.match(zero, /余额.*0|0.*余额/)
  assert.doesNotMatch(zero, /Infinity|NaN|∞/)
  await page.screenshot({ path: `${output}/02-zero-comparison.png`, fullPage: true })
  checks.push('Zero-balance comparison uses an explicit zero message, never infinite ratios')

  await page.setViewportSize({ width: 390, height: 844 })
  await settled(true)
  for (const id of examples) {
    await selectExample(id)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${id}: mobile must not overflow horizontally`)
    await page.screenshot({ path: `${output}/quantity-${id}-mobile.png`, fullPage: true })
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page must not overflow horizontally')
  const panelBox = await page.getByTestId('comparison-panel').boundingBox()
  assert.ok(panelBox && panelBox.x >= -1 && panelBox.x + panelBox.width <= 391, 'Mobile comparison panel fits viewport width')
  await page.screenshot({ path: `${output}/03-comparison-mobile.png`, fullPage: true })
  await page.getByLabel('画面质量', { exact: true }).selectOption('low')
  await samplePerformance('Mobile-width comparison', 'low')
  await back(); await settled(false)
  await page.setViewportSize(desktop)
  await page.getByLabel('画面质量', { exact: true }).selectOption('high')
  await samplePerformance('Empty island', 'high')
  await page.screenshot({ path: `${output}/04-returned-island.png`, fullPage: true })
  checks.push('390px comparison controls and text stay inside viewport; both quality modes render and return successfully')
  assert.equal(errors.length, 0, errors.join('\n'))
  const report = { checkedAt: new Date().toISOString(), origin, browser: browser.version(), headless: true,
    deviceScaleFactor: 1, viewports: [desktop, { width: 1180, height: 820 }, { width: 390, height: 844 }],
    checks, errors, exampleSnapshots, warmResourceMaximum: warm, resourceSamples, performanceSamples,
    limitations: ['Automated local headless Chrome only; narrow viewport is not a real phone test.',
      'Frame p50/p95 are recent mixed browser-frame samples, not certified device FPS or sustained GPU benchmarks.',
      'Stable renderer geometry/texture counts do not prove absence of all JS or GPU memory leaks.',
      'Background cancellation uses synthetic visibility events; real OS background throttling is not covered.',
      'Screenshots require visual review; automated layout checks do not prove artistic quality.',
      'No screen recording; independent ephemeral browser context; no actual user ledger data.'] }
  await writeFile('docs/comparison-browser-check.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {})
  console.error(JSON.stringify({ errors, completed: checks, failure: String(error), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
  throw error
} finally { await browser.close() }
