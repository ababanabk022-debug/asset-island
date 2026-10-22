import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' })
const errors = [], checks = [], samples = []
page.on('pageerror', error => errors.push(error.message))
const idle = () => page.getByRole('button', { name: '跳过动画', exact: true }).waitFor({ state: 'detached', timeout: 5000 })
const inspect = () => page.evaluate(() => window.__islandInspect())
const demoLedger = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('time-island-rebuild:reserve-demo:v1')))
const money = amount => (amount / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const balance = value => page.waitForFunction(text => document.querySelector('[data-testid="balance"]')?.textContent.includes(text), money(value))
const capture = name => page.screenshot({ path: `docs/continuous-screenshots/${name}.png` })
await mkdir('docs/continuous-screenshots', { recursive: true })
try {
  await page.goto('http://127.0.0.1:5186/')
  await page.getByText('三维小岛加载完成', { exact: true }).waitFor()
  await page.waitForTimeout(2200)
  await capture('01-ready')
  await page.getByRole('button', { name: '开启声音', exact: true }).click()
  await page.getByRole('button', { name: '近看', exact: true }).click()
  await page.waitForTimeout(950)
  const beforeCamera = (await inspect()).camera
  const start = Date.now()
  await page.getByRole('button', { name: /看进账合成/ }).click()
  await page.waitForTimeout(220); await capture('02-arrival')
  await page.waitForTimeout(430); await capture('03-merge')
  await idle()
  samples.push({ name: 'single-income-with-two-still-captures', elapsedMs: Date.now() - start })
  assert.ok(Date.now() - start < 2800, 'single income should finish promptly')
  assert.deepEqual((await inspect()).camera, beforeCamera)

  await page.getByLabel('交易金额').fill('12.34')
  let expected = 100_000
  const directions = ['income', 'income', 'income', 'expense', 'expense', 'income', 'expense', 'income', 'expense', 'income', 'expense', 'expense']
  const latencies = []
  for (const direction of directions) {
    const at = Date.now()
    assert.ok(await page.getByTestId(`transaction-${direction}`).isEnabled(), 'animation must not lock the action')
    await page.getByTestId(`transaction-${direction}`).click()
    expected += direction === 'income' ? 1234 : -1234
    await balance(expected)
    latencies.push(Date.now() - at)
    assert.equal(await page.getByLabel('交易金额').inputValue(), '12.34', 'alternating actions preserve the entered amount')
    await page.waitForTimeout(80)
  }
  const released = Date.now()
  await idle()
  const drainMs = Date.now() - released
  assert.ok(drainMs < 3800, 'rapid entries must not create a growing playback queue')
  assert.equal((await demoLedger()).entries.length, 13)
  assert.equal((await inspect()).reserve.amount, expected)
  assert.deepEqual((await inspect()).camera, beforeCamera)
  assert.match(await page.getByTestId('motion-status').innerText(), /已保存 −¥12.34/)
  samples.push({ name: '12-alternating-clicks', maximumObservedCommitMs: Math.max(...latencies), drainAfterLastClickMs: drainMs, finalFen: expected })
  checks.push('Every rapid click commits separately, +/- share the unchanged amount, controls stay usable, bounded motion catches up, camera stays unchanged')

  await page.getByLabel('交易金额').fill('25')
  await page.getByTestId('transaction-income').click(); expected += 2500
  await page.getByRole('button', { name: /岛屿手记/ }).click()
  assert.ok(await page.getByRole('button', { name: '撤销', exact: true }).first().isEnabled())
  await page.getByRole('button', { name: '撤销', exact: true }).first().click(); expected -= 2500
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await balance(expected); await idle()
  assert.equal((await demoLedger()).entries.length, 15)
  assert.equal((await inspect()).reserve.amount, expected)
  checks.push('Undo remains available during motion and records its reversal')

  for (let i = 0; i < 4; i++) { await page.getByTestId('transaction-income').click(); expected += 2500 }
  await page.getByRole('button', { name: '财富尺度', exact: true }).click()
  await page.getByTestId('camera-status').filter({ hasText: '对比中' }).waitFor()
  assert.equal((await inspect()).reserve.amount, expected)
  assert.equal((await inspect()).reserve.transactionId, null)
  await page.getByRole('button', { name: '回到我的小岛', exact: true }).click()
  await page.getByTestId('camera-status').filter({ hasText: '我的小岛' }).waitFor()
  assert.deepEqual((await inspect()).camera, beforeCamera)
  checks.push('Comparison drains queued presentation to committed money and restores the exact camera')

  await page.getByTestId('transaction-income').click(); expected += 2500
  const canvas = await page.locator('canvas').boundingBox()
  const dragX = canvas.x + canvas.width * .46, dragY = canvas.y + canvas.height * .6
  await page.mouse.move(dragX, dragY); await page.mouse.down()
  await page.mouse.move(dragX + 95, dragY - 35, { steps: 12 }); await page.mouse.up()
  await page.waitForTimeout(1100)
  const dragged = (await inspect()).camera
  assert.ok(dragged.position.some((value, index) => Math.abs(value - beforeCamera.position[index]) > .1))
  await idle(); await balance(expected)
  assert.ok((await inspect()).camera.position.every(Number.isFinite))
  await capture('04-drag-during-income')
  checks.push('Pointer orbit remains responsive while income is in motion')

  await page.getByRole('button', { name: '我的账本', exact: true }).click()
  await page.getByLabel('起始余额（元）').fill('19900')
  await page.getByRole('button', { name: '建立我的小岛' }).click()
  await balance(1_990_000)
  await page.getByLabel('交易金额').fill('200')
  for (const direction of ['income', 'expense', 'income', 'expense']) {
    await page.getByTestId(`transaction-${direction}`).click()
    await page.waitForTimeout(90)
  }
  await balance(1_990_000); await idle(); await page.waitForTimeout(1000)
  assert.equal((await inspect()).reserve.amount, 1_990_000)
  assert.ok((await inspect()).camera.position.every(Number.isFinite))
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('time-island-rebuild:personal:v1')))
  assert.equal(saved.ledger.entries.length, 4)
  checks.push('Repeated 20k threshold crossings keep all four entries and reach the correct final scene')

  await page.getByRole('button', { name: '先体验', exact: true }).click()
  await page.getByTestId('transaction-income').click()
  await page.getByTestId('transaction-expense').click()
  await page.getByRole('button', { name: '我的账本', exact: true }).click()
  await idle(); await balance(1_990_000)
  assert.equal((await inspect()).reserve.amount, 1_990_000)
  checks.push('Switching ledgers discards only presentation work, with each ledger preserved')

  await page.getByRole('button', { name: '先体验', exact: true }).click()
  await page.getByRole('button', { name: '回到初始视角', exact: true }).click()
  await page.waitForTimeout(1000)
  await capture('04-desktop')
  for (const [width, height] of [[1180, 820], [390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(400)
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      actions: [...document.querySelectorAll('.transaction-submit')].map(el => ({ bottom: el.getBoundingClientRect().bottom, width: el.getBoundingClientRect().width })),
    }))
    assert.equal(layout.overflow, false)
    if (width < 760) assert.ok(layout.actions.every(action => action.bottom <= height && action.width >= 120))
    samples.push({ width, height, ...layout })
    await capture(`05-${width}`)
  }
  checks.push('Both transaction actions fit the first mobile screen at 390 and 360 pixels')
  assert.deepEqual(errors, [])
  await writeFile('docs/continuous-browser-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), browser: browser.version(), checks, samples, errors, recording: false }, null, 2) + '\n')
  console.log(JSON.stringify({ checks, samples, errors }, null, 2))
} finally { await browser.close() }
