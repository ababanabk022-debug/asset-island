import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' })
const errors = []
const output = process.argv[2] || 'docs/playable-review'
page.on('pageerror', e => errors.push(e.message))
page.on('console', e => { if (e.type() === 'error') errors.push(e.text()) })
try {
  await mkdir(output, { recursive: true })
  await page.goto('http://127.0.0.1:5186/')
  await page.getByText('三维小岛加载完成', { exact: true }).waitFor({ timeout: 20000 })
  await page.waitForTimeout(2300)
  await page.screenshot({ path: `${output}/01-home.png` })
  const ready = await page.evaluate(() => ({ camera: window.__islandInspect(), reserve: window.__reserveInspect() }))
  await page.getByLabel('交易金额').fill('100')
  await page.getByTestId('transaction-income').click()
  await page.waitForTimeout(220)
  await page.screenshot({ path: `${output}/02-cloud-drop.png` })
  await page.waitForTimeout(1800)
  await page.getByRole('button', { name: '近看', exact: true }).click()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${output}/03-close.png` })
  const after = await page.evaluate(() => ({ camera: window.__islandInspect(), reserve: window.__reserveInspect() }))
  for (const [name, file] of [['正面', '04-front'], ['背面', '05-back']]) {
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForTimeout(1100)
    await page.screenshot({ path: `${output}/${file}.png` })
  }
  await writeFile(`${output}/inspect.json`, JSON.stringify({ ready, after, errors }, null, 2))
  console.log(JSON.stringify({ errors, initial: { ...ready.reserve, pieces: ready.reserve.pieces.length }, after: { ...after.reserve, pieces: after.reserve.pieces.length } }, null, 2))
} finally { await browser.close() }
