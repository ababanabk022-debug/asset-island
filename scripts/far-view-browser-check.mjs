import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { comparisonLayout, MUSK_SNAPSHOT } from '../src/domain/comparison.ts'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' })
const errors = [], checks = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
const inspect = () => page.evaluate(() => window.__islandInspect())
function sameCamera(actual, expected) {
  for (const key of ['position', 'target']) for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[key][i] - expected[key][i]) < 1e-4, `${key} moved during transaction`)
}
try {
  await mkdir('docs/comparison-screenshots', { recursive: true })
  await page.goto('http://127.0.0.1:5186/', { waitUntil: 'networkidle' })
  await page.getByText('三维小岛加载完成', { exact: true }).waitFor()
  await page.getByRole('button', { name: '正面', exact: true }).click()
  await page.locator('canvas').hover()
  await page.mouse.wheel(0, 700)
  await page.waitForTimeout(800)
  const far = (await inspect()).camera
  await page.getByRole('button', { name: /看进账合成/ }).click()
  await page.getByTestId('transaction-beacon').waitFor({ state: 'visible' })
  assert.match(await page.getByTestId('transaction-beacon').textContent(), /收入到岸.*200\.00/)
  sameCamera((await inspect()).camera, far)
  await page.screenshot({ path: 'docs/comparison-screenshots/05-far-income.png' })
  await page.getByRole('button', { name: '跳过动画', exact: true }).click()
  await page.getByTestId('transaction-beacon').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '背面', exact: true }).click()
  await page.waitForTimeout(400)
  const back = (await inspect()).camera
  await page.getByRole('button', { name: /看出账拆分/ }).click()
  await page.getByTestId('transaction-beacon').waitFor({ state: 'visible' })
  assert.match(await page.getByTestId('transaction-beacon').textContent(), /支出离岛.*250\.00/)
  sameCamera((await inspect()).camera, back)
  await page.screenshot({ path: 'docs/comparison-screenshots/06-back-expense.png' })
  await page.getByRole('button', { name: '跳过动画', exact: true }).click()
  await page.getByTestId('transaction-beacon').waitFor({ state: 'detached' })
  checks.push('Far front income and back-view expense have visible exact-amount locators without changing the chosen camera; skip removes locator')
  await page.getByLabel('减少动态效果', { exact: true }).check()
  await page.getByRole('button', { name: '看看财富量级', exact: true }).click()
  await page.getByTestId('comparison-example-musk').click()
  await page.locator('canvas').hover()
  await page.mouse.wheel(0, -20000)
  await page.waitForTimeout(600)
  const state = await inspect(), layout = comparisonLayout(MUSK_SNAPSHOT.amount)
  const min = [Math.min(-8.3, layout.boundsMin[0]), -.75, Math.min(-8.3, layout.boundsMin[2])]
  const max = [8.3, Math.max(4.9, layout.boundsMax[1]), Math.max(8.3, layout.boundsMax[2])]
  const radius = Math.hypot(...max.map((value, i) => value - min[i])) / 2
  assert.ok(Math.hypot(...state.camera.position.map((value, i) => value - state.camera.target[i])) >= radius * 1.08 - 1e-4)
  assert.equal(await page.locator('.comparison-world-marker').count(), 2)
  checks.push('Extreme comparison zoom remains outside the combined bounding sphere; two world-position labels remain mounted')
  await page.getByRole('button', { name: '回到我的小岛', exact: true }).click()
  sameCamera((await inspect()).camera, back)
  assert.equal(await page.locator('.comparison-world-marker').count(), 0)
  assert.deepEqual(errors, [])
  const report = { checkedAt: new Date().toISOString(), checks, errors, browser: browser.version(), limitations: 'Local headless Chrome only; no video or real mobile hardware test.' }
  await writeFile('docs/far-view-check.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
