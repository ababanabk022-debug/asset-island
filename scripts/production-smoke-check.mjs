import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import assert from 'node:assert/strict'

// Start and stop only this child, on an isolated strict port. Never terminate an existing service.
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5187', '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let output = '', browser
server.stdout.on('data', data => { output += data })
server.stderr.on('data', data => { output += data })
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(new Error('Preview startup timed out: ' + output)) }, 10000)
    const poll = setInterval(() => { if (output.includes('http://127.0.0.1:5187/')) { clearTimeout(timeout); clearInterval(poll); resolve() } }, 100)
    server.once('error', error => { clearTimeout(timeout); clearInterval(poll); reject(error) })
    server.once('exit', code => { clearTimeout(timeout); clearInterval(poll); reject(new Error(`Preview exited ${code}: ${output}`)) })
  })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('http://127.0.0.1:5187/', { waitUntil: 'networkidle' })
  await page.getByText('三维小岛加载完成', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => typeof window.__islandInspect), 'undefined')
  assert.equal(await page.evaluate(() => typeof window.__islandSoundInspect), 'undefined')
  assert.equal(await page.evaluate(() => typeof window.__reserveInspect), 'undefined')
  assert.equal(await page.evaluate(() => typeof window.__comparisonMotionInspect), 'undefined')
  await page.getByRole('button', { name: /看看财富量级/ }).click()
  for (const id of ['10k', '100k', '1m', 'musk']) {
    await page.getByTestId(`comparison-example-${id}`).click()
    await page.getByTestId('camera-status').filter({ hasText: '对比中' }).waitFor()
    await page.getByTestId('comparison-own-marker').waitFor({ state: 'visible' })
  }
  await page.getByRole('button', { name: '回到我的小岛', exact: true }).click()
  await page.getByRole('button', { name: '打开设置' }).click(); await page.getByLabel('减少动态效果', { exact: true }).uncheck(); await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: /看进账合成/ }).click()
  await page.getByTestId('transaction-beacon').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '跳过动画', exact: true }).click()
  assert.match(await page.getByTestId('balance').textContent(), /20,000\.00/)
  assert.deepEqual(errors, [])
  const report = { checkedAt: new Date().toISOString(), browser: browser.version(), errors,
    checks: ['Built preview loads assets and CSS', 'No development inspection API exposed', 'Three count examples and historical Musk snapshot, world labels and return work', 'Transaction locator and skip preserve committed balance'],
    preview: 'Temporary own child on strict port 5187; closed after test' }
  await writeFile('docs/production-smoke-check.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close()
  server.kill()
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve) })
}
