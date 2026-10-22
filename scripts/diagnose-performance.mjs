import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5187', '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let startup = '', browser
server.stdout.on('data', b => { startup += b }); server.stderr.on('data', b => { startup += b })
const reports = []
function cpuSummary(profile) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n])), totals = new Map()
  profile.samples?.forEach((id, i) => {
    const frame = nodes.get(id).callFrame
    const key = `${frame.functionName || '(anonymous)'}|${frame.url}|${frame.lineNumber + 1}`
    totals.set(key, (totals.get(key) || 0) + profile.timeDeltas[i] / 1000)
  })
  return [...totals].sort((a, b) => b[1] - a[1]).filter(([key]) => !key.startsWith('(idle)')).slice(0, 14).map(([frame, selfMs]) => ({ frame, selfMs: Math.round(selfMs) }))
}
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(new Error(startup)) }, 10000)
    const poll = setInterval(() => {
      if (server.exitCode !== null) { clearTimeout(timeout); clearInterval(poll); reject(new Error(startup)) }
      else if (startup.includes('http://127.0.0.1:5187/')) { clearTimeout(timeout); clearInterval(poll); resolve() }
    }, 100)
    server.once('error', reject)
  })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const [mode, port] of [['development', 5186], ['production', 5187]]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(() => {
      const state = { running: false, frames: [], tasks: [], gl: {}, start: 0, last: 0 }
      new PerformanceObserver(list => {
        if (state.running) for (const e of list.getEntries()) if (e.startTime >= state.start) state.tasks.push({ at: e.startTime - state.start, ms: e.duration })
      }).observe({ entryTypes: ['longtask'] })
      const frame = t => {
        if (state.running) { if (state.last) state.frames.push(t - state.last); state.last = t }
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
      for (const method of ['compileShader', 'linkProgram', 'getProgramParameter', 'getShaderParameter', 'texImage2D', 'bufferData']) {
        const original = WebGL2RenderingContext.prototype[method]
        WebGL2RenderingContext.prototype[method] = function (...args) {
          if (!state.running) return original.apply(this, args)
          const start = performance.now(), value = original.apply(this, args), ms = performance.now() - start
          const item = state.gl[method] ??= { calls: 0, ms: 0, maxMs: 0 }
          item.calls++; item.ms += ms; item.maxMs = Math.max(item.maxMs, ms)
          return value
        }
      }
      window.__measure = {
        begin() { Object.assign(state, { running: true, frames: [], tasks: [], gl: {}, start: performance.now(), last: 0 }) },
        end() { state.running = false; return { ...state, elapsed: performance.now() - state.start } },
      }
    })
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' })
    await page.getByText('三维小岛加载完成', { exact: true }).waitFor()
    await page.waitForTimeout(3000)
    const renderer = await page.evaluate(() => {
      const gl = document.querySelector('canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info')
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    })
    const session = await page.context().newCDPSession(page)
    if (mode === 'development') { await session.send('Profiler.enable'); await session.send('Profiler.setSamplingInterval', { interval: 1000 }) }
    async function measure(name, action, duration) {
      if (mode === 'development') await session.send('Profiler.start')
      await page.evaluate(() => window.__measure.begin())
      if (action) await action()
      await page.waitForTimeout(duration)
      const data = await page.evaluate(() => window.__measure.end())
      const cpu = mode === 'development' ? cpuSummary((await session.send('Profiler.stop')).profile) : undefined
      const sorted = data.frames.filter(v => v > 0).sort((a, b) => a - b)
      const p = q => sorted[Math.floor((sorted.length - 1) * q)]
      const row = { mode, name, frames: sorted.length, p50: p(.5), p95: p(.95), max: p(1), over33: sorted.filter(v => v > 33.4).length,
        over100: sorted.filter(v => v > 100).length, tasks: data.tasks, gl: data.gl, cpu }
      reports.push(row)
      console.log(JSON.stringify({ mode, name, p50: row.p50, p95: row.p95, max: row.max, over100: row.over100, longTasks: row.tasks }))
    }
    const enter = () => page.getByRole('button', { name: /看看财富量级/ }).click()
    const select = id => page.getByTestId(`comparison-example-${id}`).click()
    const back = () => page.getByRole('button', { name: '回到我的小岛', exact: true }).click()
    const idle = () => page.getByRole('button', { name: '跳过动画', exact: true }).waitFor({ state: 'detached', timeout: 20000 })
    await measure('idle-high', null, 3500)
    await measure('income-high', () => page.getByRole('button', { name: /看进账合成/ }).click(), 2800); await idle()
    await measure('expense-high', () => page.getByRole('button', { name: /看出账拆分/ }).click(), 2800); await idle()
    await measure('enter-small-high', enter, 2300)
    await measure('five-gold-arrival-high', () => select('100k'), 2500)
    await measure('fifty-gold-arrival-high', () => select('1m'), 2500)
    await measure('musk-first-high', () => select('musk'), 3500)
    await measure('musk-idle-high', null, 3500)
    await select('1m'); await page.waitForTimeout(2000)
    await measure('musk-repeat-high', () => select('musk'), 3500)
    await measure('return-high', back, 2300)
    await page.getByRole('button', { name: '打开设置' }).click(); await page.getByLabel('画面质量', { exact: true }).selectOption('low'); await page.getByRole('button', { name: '关闭', exact: true }).click(); await page.waitForTimeout(2000)
    await measure('idle-low', null, 3500)
    await measure('income-low', () => page.getByRole('button', { name: /看进账合成/ }).click(), 2800); await idle()
    await measure('hundred-sand-arrival-low', enter, 2500)
    await measure('fifty-gold-arrival-low', () => select('1m'), 2500)
    await measure('musk-repeat-low', () => select('musk'), 3500)
    await back(); await page.getByTestId('camera-status').filter({ hasText: '我的小岛' }).waitFor()
    await page.getByRole('button', { name: '打开设置' }).click()
    await page.getByLabel('画面质量', { exact: true }).selectOption('high')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '开启声音', exact: true }).click()
    await page.waitForTimeout(2000)
    await measure('income-audio-high', () => page.getByRole('button', { name: /看进账合成/ }).click(), 2800); await idle()
    await measure('expense-audio-high', () => page.getByRole('button', { name: /看出账拆分/ }).click(), 2800); await idle()
    await page.getByLabel('交易金额').fill('25')
    await measure('continuous-audio-high', async () => {
      for (let i = 0; i < 18; i++) {
        await page.getByTestId(i < 12 ? 'transaction-income' : 'transaction-expense').click()
        await page.waitForTimeout(80)
      }
    }, 4000); await idle()
    // At 200:1 the near-threshold sandstone pile is heavier than the maximum
    // balance's 50 gold bodies. Measure both, including real pointer motion.
    await page.getByRole('button', { name: '我的账本', exact: true }).click()
    await page.getByLabel('起始余额（元）').fill('19900')
    await measure('199-stones-settling-high', () => page.getByRole('button', { name: '建立我的小岛' }).click(), 4500)
    const canvas = await page.locator('canvas').boundingBox()
    const orbit = async () => {
      const x = canvas.x + canvas.width * .83, y = canvas.y + canvas.height * .18
      await page.mouse.move(x, y); await page.mouse.down()
      await page.mouse.move(x - 110, y + 25, { steps: 15 })
      await page.mouse.move(x - 35, y - 15, { steps: 12 })
      await page.mouse.up()
    }
    await measure('199-stones-orbit-high', orbit, 3500)
    await page.getByLabel('交易金额').fill('100')
    await measure('200-stones-merge-high', () => page.getByTestId('transaction-income').click(), 3500); await idle()
    await measure('199-stones-split-high', () => page.getByTestId('transaction-expense').click(), 3500); await idle()
    await page.getByLabel('交易金额').fill('980100')
    await measure('million-transfer-high', () => page.getByTestId('transaction-income').click(), 4500); await idle()
    if (!/1,000,000\.00/.test(await page.getByTestId('balance').textContent())) throw new Error('Performance workload did not reach the personal maximum')
    await measure('million-orbit-high', orbit, 3500)
    await page.waitForTimeout(7000)
    await measure('million-rest-high', null, 3000)
    await page.getByRole('button', { name: '打开设置' }).click()
    await page.getByLabel('画面质量', { exact: true }).selectOption('low')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.waitForTimeout(1000)
    await measure('million-orbit-low', orbit, 3500)
    console.log(JSON.stringify({ mode, renderer, errors }))
    reports.push({ mode, renderer, errors })
    await page.close()
  }
  await writeFile(process.argv[2] || 'docs/performance-diagnosis.json', JSON.stringify({ checkedAt: new Date().toISOString(), browser: browser.version(), viewport: '1440x1000 DPR1',
    limitations: ['Independent headless Chrome; not the user browser session or real phone.', 'Development measurements include 1ms CPU sampling overhead. Production is measured without CPU profiler.', 'WebGL method durations are CPU-side waits, not GPU timer queries.', 'No screen recording; no business source changes.'], reports }, null, 2))
} finally {
  await browser?.close(); server.kill()
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve) })
}

