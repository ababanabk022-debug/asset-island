import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.argv[2]
assert.equal(new URL(url).protocol, 'https:', 'Public deployment must use HTTPS')
const output = 'docs/sites-public-0.9.0'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' })
const page = await context.newPage()
const errors = [], consoleErrors = [], checks = [], assets = []
let failure
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
const ready = () => page.getByText('三维小岛加载完成', { exact: true }).waitFor({ timeout: 60000 })
const amount = expected => page.waitForFunction(text => document.querySelector('[data-testid="balance"]')?.textContent?.includes(text), expected)
const settled = () => page.getByRole('button', { name: '跳过动画', exact: true }).waitFor({ state: 'detached', timeout: 20000 })
try {
  const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
  assert.equal(response.status(), 200)
  assert.equal(new URL(page.url()).origin, new URL(url).origin, 'No sign-in redirect')
  await ready()
  assert.equal(await page.evaluate(() => isSecureContext && !!navigator.locks && typeof crypto.randomUUID === 'function'), true)
  for (const file of ['island-study.glb', 'gold.glb', 'sandstone.glb', 'island-collision.bin']) {
    const served = await context.request.get(new URL(`/generated/${file}`, url).href)
    assert.equal(served.status(), 200, file)
    const digest = bytes => createHash('sha256').update(bytes).digest('hex')
    const hash = digest(await served.body())
    assert.equal(hash, digest(await readFile(`assets/runtime/${file}`)), `${file}: deployed bytes match verified source`)
    assets.push({ file, sha256: hash, contentType: served.headers()['content-type'] })
  }
  checks.push('Anonymous HTTPS entry, no sign-in redirect, working WebGL/WASM and exact deployed scene/collision bytes')
  await page.evaluate(async () => document.fonts.ready)
  await page.screenshot({ path: `${output}/01-public-home.png` })
  await page.getByRole('button', { name: /看进账合成/ }).click()
  await amount('20,000.00'); await settled()
  await page.getByRole('button', { name: /看出账拆分/ }).click()
  await amount('19,750.00'); await settled()
  checks.push('Published demo completes 200:1 income merge and expense split with exact committed balances')
  await page.getByRole('button', { name: '财富尺度', exact: true }).click()
  for (const id of ['10k', '100k', '1m', 'musk']) {
    await page.getByTestId(`comparison-example-${id}`).click()
    await page.getByTestId('camera-status').filter({ hasText: '对比中' }).waitFor({ timeout: 15000 })
    await page.waitForTimeout(800)
    if (id === '1m') await page.screenshot({ path: `${output}/02-public-comparison.png` })
  }
  await page.getByRole('button', { name: '回到我的小岛', exact: true }).click()
  await page.getByTestId('camera-status').filter({ hasText: '我的小岛' }).waitFor()
  checks.push('All four public comparison scales and return work, including ordinary arrival animation')
  await page.getByRole('button', { name: '我的账本', exact: true }).click()
  await page.getByLabel('起始余额（元）').fill('100')
  await page.getByRole('button', { name: '建立我的小岛' }).click()
  await amount('100.00')
  await page.getByLabel('交易金额').fill('0.01')
  await page.getByTestId('transaction-income').click()
  await amount('100.01')
  await page.reload({ waitUntil: 'networkidle' }); await ready(); await amount('100.01')
  checks.push('Isolated visitor ledger saves exact cents and survives reload on the new HTTPS origin')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(async () => document.fonts.ready)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  for (const id of ['transaction-income', 'transaction-expense']) {
    const box = await page.getByTestId(id).boundingBox()
    assert.ok(box && box.y >= 0 && box.y + box.height <= 844, `${id} is in the first screen`)
  }
  await page.screenshot({ path: `${output}/03-public-mobile.png`, fullPage: true })
  checks.push('390px browser viewport keeps both transaction buttons visible without horizontal overflow')
  assert.deepEqual(errors, [])
  assert.deepEqual(consoleErrors, [])
} catch (error) {
  failure = { message: error.message, stack: error.stack }
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {})
} finally {
  const report = { checkedAt: new Date().toISOString(), url, browser: browser.version(), passed: !failure,
    checks, assets, errors, consoleErrors, ...(failure ? { failure } : {}),
    storage: 'New anonymous browser context and synthetic test ledger only; no existing user data.',
    limitations: ['One network location and Chrome, not an all-region availability guarantee.', 'Mobile viewport simulation, not a real phone.'], recording: false }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}
if (failure) process.exitCode = 1
