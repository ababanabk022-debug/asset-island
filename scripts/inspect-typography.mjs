import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.TEST_URL || 'http://127.0.0.1:5186'
const output = 'docs/typography-0.9.0'
const startedAt = Date.now()
const checks = [], samples = [], errors = [], consoleErrors = [], failedRequests = []
const fontRequests = new Map()
const viewports = [[1440, 900], [1180, 820], [390, 844], [360, 800]]
const isNoto = name => /Noto.*Sans.*(?:SC|CJK|Hans)/i.test(name)
let failure
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const cdp = await page.context().newCDPSession(page)
await cdp.send('DOM.enable')
await cdp.send('CSS.enable')
await cdp.send('Network.enable')
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('requestfailed', request => failedRequests.push({ url: request.url(), reason: request.failure()?.errorText }))
cdp.on('Network.responseReceived', ({ requestId, type, response }) => {
  if (type !== 'Font' && !/font|woff/i.test(response.mimeType)) return
  fontRequests.set(requestId, {
    url: response.url, status: response.status, mimeType: response.mimeType,
    sameOrigin: new URL(response.url).origin === new URL(base).origin,
    fromDiskCache: response.fromDiskCache ?? false, fromServiceWorker: response.fromServiceWorker ?? false,
    contentLength: Number(response.headers['content-length'] ?? response.headers['Content-Length']) || null,
  })
})
cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
  const request = fontRequests.get(requestId)
  if (request) request.transferredBytes = encodedDataLength
})

const shot = name => page.screenshot({ path: `${output}/${name}.png` })
async function fontsReady() {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}
async function resize(width, height) {
  await page.setViewportSize({ width, height })
  await page.evaluate(() => scrollTo(0, 0))
  await fontsReady()
}
async function actualFonts(selector, name) {
  const { root } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
  assert.ok(nodeId, `${name}: the text node exists`)
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
  const used = fonts.filter(font => font.glyphCount > 0)
  assert.ok(used.length, `${name}: CDP reports actual rendered glyph fonts`)
  assert.ok(used.every(font => font.isCustomFont && isNoto(font.familyName)),
    `${name}: every rendered glyph uses the custom Noto font: ${JSON.stringify(used)}`)
  const computed = await page.locator(selector).first().evaluate(element => {
    const style = getComputedStyle(element)
    return { family: style.fontFamily, weight: style.fontWeight, size: style.fontSize, lineHeight: style.lineHeight }
  })
  return { name, selector, computed, platformFonts: used }
}
async function textBounds(selector, name) {
  const result = await page.locator(selector).first().evaluate(element => {
    const rect = element.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(element)
    const text = range.getBoundingClientRect()
    const directTextTops = []
    for (const child of element.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim()) continue
      const direct = document.createRange()
      direct.selectNodeContents(child)
      for (const bounds of direct.getClientRects()) directTextTops.push(bounds.top)
    }
    const parents = []
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const bounds = parent.getBoundingClientRect(), style = getComputedStyle(parent)
      parents.push({
        tag: parent.tagName, className: parent.className, left: bounds.left, right: bounds.right,
        overflowX: style.overflowX,
      })
    }
    return {
      text: element.textContent, left: rect.left, right: rect.right, width: rect.width,
      textLeft: text.left, textRight: text.right, textHeight: text.height, directTextTops,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      viewport: innerWidth, parents,
    }
  })
  assert.ok(result.width > 0 && result.textHeight > 0, `${name}: visible text has nonzero size`)
  assert.ok(result.textLeft >= result.left - 1.25 && result.textRight <= result.right + 1.25,
    `${name}: glyphs fit their own box: ${JSON.stringify(result)}`)
  assert.ok(result.textLeft >= -1 && result.textRight <= result.viewport + 1,
    `${name}: text stays within the viewport: ${JSON.stringify(result)}`)
  if (/amount|balance|count/.test(name) && result.directTextTops.length) {
    assert.ok(Math.max(...result.directTextTops) - Math.min(...result.directTextTops) <= 1.25,
      `${name}: a monetary number stays on one line: ${JSON.stringify(result)}`)
  }
  for (const parent of result.parents) {
    if (!['hidden', 'clip', 'auto', 'scroll'].includes(parent.overflowX)) continue
    assert.ok(result.textLeft >= parent.left - 1.25 && result.textRight <= parent.right + 1.25,
      `${name}: no ancestor clips the amount: ${JSON.stringify({ result, parent })}`)
  }
  return { name, ...result }
}
async function noHorizontalOverflow(name) {
  const result = await page.evaluate(() => ({
    viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    dialogs: [...document.querySelectorAll('dialog[open]')].map(element => ({
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
    })),
  }))
  assert.ok(result.documentWidth <= result.viewport + 1 && result.bodyWidth <= result.viewport + 1,
    `${name}: no page horizontal overflow: ${JSON.stringify(result)}`)
  assert.ok(result.dialogs.every(dialog => dialog.scrollWidth <= dialog.clientWidth + 1),
    `${name}: no horizontal dialog scrolling: ${JSON.stringify(result)}`)
  return result
}
async function homeLayout(name) {
  await fontsReady()
  const layout = await page.evaluate(() => {
    const rect = element => {
      const box = element.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width }
    }
    const label = document.querySelector('.reserve-balance>span')
    const balance = document.querySelector('.reserve-balance strong')
    const panel = document.querySelector('.study-panel')
    const input = document.querySelector('#transaction-amount')
    return {
      width: innerWidth, height: innerHeight, label: rect(label), balance: rect(balance),
      panelOverflow: panel.scrollHeight - panel.clientHeight,
      actions: [...document.querySelectorAll('.transaction-submit')].map(rect),
      input: { value: input.value, clientWidth: input.clientWidth, scrollWidth: input.scrollWidth },
    }
  })
  const sameRow = Math.min(layout.label.bottom, layout.balance.bottom) > Math.max(layout.label.top, layout.balance.top) + 1
  if (sameRow) assert.ok(layout.label.right <= layout.balance.left + 1, `${name}: label and balance never overlap`)
  assert.ok(layout.input.scrollWidth <= layout.input.clientWidth + 1, `${name}: the maximum input amount is not clipped`)
  assert.equal(layout.actions.length, 2)
  if (layout.width <= 760) {
    assert.ok(layout.actions.every(action => action.width >= 120 && action.left >= 0 &&
      action.right <= layout.width && action.top >= 0 && action.bottom <= layout.height),
    `${name}: both mobile transaction buttons remain in the first screen: ${JSON.stringify(layout.actions)}`)
  } else {
    assert.ok(layout.panelOverflow <= 1, `${name}: desktop panel fits without internal scrolling: ${JSON.stringify(layout)}`)
  }
  const sample = {
    name, layout, overflow: await noHorizontalOverflow(name),
    amount: await textBounds('[data-testid="balance"]', `${name} balance`),
    fonts: [
      await actualFonts('.scene-heading h1', `${name} Chinese heading`),
      await actualFonts('[data-testid="balance"]', `${name} currency and numbers`),
    ],
  }
  samples.push(sample)
}
async function closeDialog() {
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('dialog').waitFor({ state: 'detached' })
}
async function visibleAction(locator, name, requireVisible = true) {
  const result = await locator.evaluate(button => {
    const bounds = element => {
      const rect = element.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height }
    }
    const rect = bounds(button), ancestors = []
    let visibleTop = Math.max(0, rect.top), visibleBottom = Math.min(innerHeight, rect.bottom)
    for (let parent = button.parentElement; parent; parent = parent.parentElement) {
      const overflowY = getComputedStyle(parent).overflowY
      if (['auto', 'scroll', 'hidden', 'clip'].includes(overflowY)) {
        const box = bounds(parent)
        visibleTop = Math.max(visibleTop, box.top)
        visibleBottom = Math.min(visibleBottom, box.bottom)
        ancestors.push({ className: parent.className, overflowY, ...box,
          scrollTop: parent.scrollTop, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight })
      }
    }
    const visibleHeight = Math.max(0, visibleBottom - visibleTop)
    const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)
    return { ...rect, viewportHeight: innerHeight, visibleHeight, hitTest: button === hit || button.contains(hit),
      clippedPixels: Math.max(0, rect.height - visibleHeight), fullyVisible: visibleHeight >= rect.height - 1, ancestors }
  })
  if (requireVisible) {
    assert.ok(result.fullyVisible, `${name}: the complete action fits every clipping ancestor: ${JSON.stringify(result)}`)
    assert.ok(result.hitTest, `${name}: the action is exposed to an actual pointer`)
  }
  return result
}
try {
  await page.goto(base)
  await page.getByText('三维小岛加载完成', { exact: true }).waitFor({ timeout: 30000 })
  await fontsReady()
  const denominationText = await page.locator('.merge-meter p').innerText()
  assert.match(denominationText, /200\s*块砂岩/)
  assert.match(denominationText, /金矿\s*¥20,000/)
  samples.push({ name: 'v0.9-denomination-text', text: denominationText })
  const faces = await page.evaluate(() => [...document.fonts].map(face => ({
    family: face.family, status: face.status, weight: face.weight, style: face.style,
  })))
  assert.ok(faces.some(face => face.status === 'loaded' && /Noto/i.test(face.family)),
    'A declared Noto font face has actually loaded')
  samples.push({ name: 'font-face-status', faces })
  await page.getByLabel('交易金额', { exact: true }).fill('1000000.00')
  for (const [width, height] of viewports) {
    await resize(width, height)
    await homeLayout(`home-${width}`)
    if (width === 1440 || width === 360) await shot(`01-home-${width}`)
  }
  checks.push('1440, 1180, 390 and 360 home layouts render custom Noto Chinese and numbers, without clipping or hidden transaction actions')

  await resize(1440, 900)
  await page.getByRole('button', { name: '我的账本', exact: true }).click()
  await page.getByLabel('起始余额（元）').fill('1000000')
  await page.getByRole('button', { name: '建立我的小岛', exact: true }).click()
  await page.waitForFunction(() => window.__reserveInspect?.().amount === 100_000_000)
  for (const [width, height] of viewports) {
    await resize(width, height)
    await homeLayout(`million-${width}`)
    if (width === 360) await shot('02-million-360')
  }
  checks.push('The maximum ¥1,000,000.00 balance and maximum input amount remain readable at all four viewport sizes')

  await resize(1440, 900)
  await page.getByRole('button', { name: '财富尺度', exact: true }).click()
  await page.getByTestId('comparison-example-musk').click()
  samples.push({ name: 'desktop-flight-actions',
    returnAction: await visibleAction(page.getByRole('button', { name: '回到我的小岛', exact: true }), 'Desktop outbound return'),
    skipAction: await visibleAction(page.getByRole('button', { name: '直接到达', exact: true }), 'Desktop outbound skip') })
  await page.getByTestId('camera-status').filter({ hasText: '对比中' }).waitFor()
  assert.match((await page.getByTestId('comparison-count').innerText()).replace(/[,，]/g, ''), /290411460\s*块金矿/)
  for (const [width, height] of [[1440, 900], [1180, 820], [360, 800]]) {
    await resize(width, height)
    assert.match(await page.getByTestId('comparison-amount').innerText(), /5\.81\s*万亿/)
    samples.push({
      name: `comparison-${width}`, overflow: await noHorizontalOverflow(`comparison-${width}`),
      returnAction: await visibleAction(page.getByRole('button', { name: '回到我的小岛', exact: true }), `Comparison ${width} return`, width > 760),
      amounts: [
        await textBounds('[data-testid="comparison-amount"]', `comparison-${width} historical amount`),
        await textBounds('.comparison-own strong', `comparison-${width} own balance`),
        await textBounds('[data-testid="comparison-count"] b', `comparison-${width} exact gold count`),
      ],
      fonts: [
        await actualFonts('.comparison-scene-heading h1', `comparison-${width} scene heading`),
        await actualFonts('.comparison-panel h2', `comparison-${width} panel heading`),
        await actualFonts('[data-testid="comparison-amount"]', `comparison-${width} historical amount`),
        await actualFonts('.comparison-option-number', `comparison-${width} option number`),
      ],
    })
    if (width === 1440) await shot('03-comparison-1440')
  }
  await resize(1440, 900)
  await page.getByText('估值日期与来源', { exact: true }).click()
  await page.locator('.study-panel').evaluate(panel => { panel.scrollTop = panel.scrollHeight })
  await fontsReady()
  const sourceBounds = await page.evaluate(() => {
    const last = document.querySelector('.comparison-source-note details p:last-child').getBoundingClientRect()
    const panel = document.querySelector('.study-panel').getBoundingClientRect()
    const actions = document.querySelector('.comparison-actions').getBoundingClientRect()
    return { lastTop: last.top, lastBottom: last.bottom, panelTop: panel.top, actionTop: actions.top }
  })
  assert.ok(sourceBounds.lastTop >= sourceBounds.panelTop && sourceBounds.lastBottom <= sourceBounds.actionTop + 1,
    `The expanded source can be read to its last paragraph above the sticky actions: ${JSON.stringify(sourceBounds)}`)
  samples.push({ name: 'expanded-comparison-source', sourceBounds,
    returnAction: await visibleAction(page.getByRole('button', { name: '回到我的小岛', exact: true }), 'Expanded source return') })
  await shot('03b-comparison-source-expanded-1440')
  await page.locator('.comparison-source-note summary').click()
  await page.locator('.study-panel').evaluate(panel => { panel.scrollTop = 0 })
  await page.getByTestId('comparison-example-1m').click()
  await page.getByTestId('camera-status').filter({ hasText: '对比中' }).waitFor()
  await page.waitForFunction(() => window.__comparisonMotionInspect?.().dropRunning === false)
  samples.push({ name: 'ordinary-comparison-actions',
    returnAction: await visibleAction(page.getByRole('button', { name: '回到我的小岛', exact: true }), 'Ordinary comparison return') })
  await shot('03c-comparison-ordinary-1440')
  checks.push('Historical ¥5.81 trillion comparison uses actual custom Noto for titles, amounts and option numbers; desktop and 360px amounts fit')
  checks.push('Desktop return and in-flight skip actions are fully exposed; expanded sources remain readable and mobile keeps normal page flow')
  await page.getByRole('button', { name: '回到我的小岛', exact: true }).click()
  await page.getByTestId('camera-status').filter({ hasText: '我的小岛' }).waitFor()
  await page.evaluate(() => scrollTo(0, 0))

  for (const [width, height] of [[1440, 900], [360, 800]]) {
    await resize(width, height)
    await page.getByRole('button', { name: '打开设置', exact: true }).click()
    await fontsReady()
    samples.push({
      name: `settings-${width}`, overflow: await noHorizontalOverflow(`settings-${width}`),
      heading: await textBounds('.sheet-heading h2', `settings-${width} title`),
      fonts: [await actualFonts('.sheet-heading h2', `settings-${width} actual title font`)],
    })
    if (width === 360) await shot('04-settings-360')
    await closeDialog()
  }
  checks.push('Desktop and 360px settings dialogs use custom Noto and keep the long heading visible without horizontal scrolling')

  const note = '这是用于字体验收的长备注，记录岛上每一笔积累与支出，也检查手机窄屏的换行和金额对齐。'.repeat(2).slice(0, 80)
  await page.getByLabel('交易金额', { exact: true }).fill('1.23')
  await page.getByLabel('记账备注', { exact: true }).fill(note)
  await page.getByTestId('transaction-expense').click()
  await page.waitForFunction(() => window.__reserveInspect?.().amount === 99_999_877)
  for (const [width, height] of [[1440, 900], [360, 800]]) {
    await resize(width, height)
    await page.getByRole('button', { name: /岛屿手记/ }).click()
    await fontsReady()
    assert.equal(await page.locator('.entry-list li strong').first().textContent(), note)
    samples.push({
      name: `ledger-${width}`, overflow: await noHorizontalOverflow(`ledger-${width}`),
      amounts: [
        await textBounds('.ledger-summary>span:first-child strong', `ledger-${width} current balance`),
        await textBounds('.ledger-summary>span:last-child strong', `ledger-${width} initial million balance`),
        await textBounds('.entry-value', `ledger-${width} transaction amount`),
      ],
      note: await textBounds('.entry-list li strong', `ledger-${width} 80-character note`),
      fonts: [
        await actualFonts('.ledger-summary>span:first-child strong', `ledger-${width} current balance font`),
        await actualFonts('.ledger-summary>span:last-child strong', `ledger-${width} initial balance font`),
        await actualFonts('.entry-value', `ledger-${width} transaction value font`),
        await actualFonts('.entry-list li strong', `ledger-${width} long note font`),
      ],
    })
    if (width === 360) await shot('05-ledger-360')
    await closeDialog()
  }
  checks.push('Desktop and 360px ledger dialogs preserve full million-balance digits, exact transaction amount and the 80-character note using custom Noto')

  const requests = [...fontRequests.values()]
  assert.ok(requests.length > 0, 'Custom fonts were requested by this isolated browser')
  assert.ok(requests.every(request => request.sameOrigin && request.status === 200),
    `Every font request is successful and same-origin: ${JSON.stringify(requests)}`)
  assert.ok(requests.every(request => Number.isFinite(request.transferredBytes)),
    'Each font request has completed and has a measured transfer byte count')
  assert.deepEqual(failedRequests.filter(request => /font|woff/i.test(request.url)), [], 'No font download failed')
  assert.deepEqual(errors, [], 'No page runtime errors')
  assert.deepEqual(consoleErrors, [], 'No browser console errors')
  checks.push('All measured font downloads are successful and same-origin; page and console errors are empty')
} catch (error) {
  failure = { message: error.message, stack: error.stack }
  await shot('failure').catch(() => {})
} finally {
  const fonts = [...fontRequests.values()]
  const report = {
    checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, base, browser: browser.version(),
    passed: !failure, checks, samples, errors, consoleErrors, failedRequests,
    fontRequests: fonts, totalFontTransferBytes: fonts.reduce((sum, font) => sum + (font.transferredBytes ?? 0), 0),
    ...(failure ? { failure } : {}), recording: false, storage: 'Fresh isolated browser context with synthetic ledger data only',
    mobile: 'Browser viewport emulation; not a physical phone',
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, checks, errors, consoleErrors,
    fonts: fonts.length, totalFontTransferBytes: report.totalFontTransferBytes, durationMs: report.durationMs, failure }, null, 2))
  await browser.close()
}
if (failure) process.exitCode = 1
