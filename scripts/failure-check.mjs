import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

const results = []
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.route('**/generated/island-study.glb', route => route.abort('failed'))
  await page.goto('http://127.0.0.1:5186/')
  await page.getByRole('alert').filter({ hasText: '小岛暂时未能加载' }).waitFor()
  assert.match(await page.getByTestId('balance').innerText(), /800\.00/)
  assert.equal(await page.getByRole('button', { name: /记入进账/ }).isDisabled(), true)
  await page.screenshot({ path: 'docs/screenshots/08-load-error.png' })
  await page.unroute('**/generated/island-study.glb')
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await page.getByText('三维小岛加载完成', { exact: true }).waitFor()
  results.push('Missing GLB shows error and readable balance, submit disabled, retry recovers')
  await page.getByRole('button', { name: /看进账合成/ }).click()
  assert.match(await page.getByTestId('balance').innerText(), /1,000\.00/)
  await page.evaluate(() => {
    const gl = document.querySelector('canvas').getContext('webgl2')
    gl.getExtension('WEBGL_lose_context').loseContext()
  })
  await page.getByRole('alert').filter({ hasText: '图形连接已中断' }).waitFor()
  await page.getByRole('button', { name: '跳过动画', exact: true }).waitFor({ state: 'detached' })
  await page.screenshot({ path: 'docs/screenshots/09-context-lost.png' })
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await page.getByText('三维小岛加载完成', { exact: true }).waitFor()
  assert.match(await page.getByTestId('balance').innerText(), /1,000\.00/)
  results.push('Context loss during transaction settles; reload preserves committed balance without replay')
} finally { await browser.close() }
const noWebGL = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-webgl'] })
try {
  const page = await noWebGL.newPage()
  await page.goto('http://127.0.0.1:5186/')
  await page.getByRole('alert').filter({ hasText: '小岛暂时未能加载' }).waitFor()
  assert.equal(await page.locator('.loading').count(), 0)
  assert.match(await page.getByTestId('balance').innerText(), /800\.00/)
  assert.equal(await page.getByRole('button', { name: /记入进账/ }).isDisabled(), true)
  results.push('Disabled WebGL shows fallback without infinite loading; balance remains readable')
} finally { await noWebGL.close() }
await writeFile('docs/failure-check.json', JSON.stringify({ results }, null, 2))
console.log(results.join('\n'))
