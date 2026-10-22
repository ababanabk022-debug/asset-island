import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' })
const errors=[], snapshots=[]
page.on('pageerror',e=>errors.push(e.message))
const inspect=()=>page.evaluate(()=>window.__islandInspect())
const settled=()=>page.getByRole('button',{name:'跳过动画',exact:true}).waitFor({state:'detached',timeout:20000})
const amount=async text=>page.waitForFunction(v=>document.querySelector('[data-testid="balance"]')?.textContent?.includes(v),text)
try {
 await page.goto('http://127.0.0.1:5186'); await page.getByText('三维小岛加载完成',{exact:true}).waitFor()
 await page.getByRole('button',{name:'我的账本',exact:true}).click();await page.getByLabel('起始余额（元）').fill('20000');await page.getByRole('button',{name:'建立我的小岛'}).click();await amount('20,000.00')
 // Hold the real persistence lock, change motion preference while a save waits,
 // then release it. A late transaction must respect the current preference.
 await page.evaluate(async () => {
  let acquired
  const ready = new Promise(resolve => { acquired = resolve })
  void navigator.locks.request('time-island-rebuild:personal:v1', () => new Promise(resolve => { window.__releaseLedgerLock = resolve; acquired() }))
  await ready
 })
 await page.getByLabel('交易金额').fill('1000');await page.getByRole('button',{name:/记入进账/}).click()
 await page.getByText('正在保存',{exact:true}).waitFor()
 await page.getByRole('button',{name:'打开设置'}).click();await page.getByLabel('减少动态效果',{exact:true}).check();await page.getByRole('button',{name:'关闭',exact:true}).click()
 await page.evaluate(()=>window.__releaseLedgerLock());await amount('21,000.00')
 await page.getByRole('button',{name:'跳过动画',exact:true}).waitFor({state:'detached',timeout:1500})
 assert.equal((await inspect()).personal.gold,1)
 assert.equal((await inspect()).personal.sand,10)
 await page.getByLabel('交易金额').fill('1000');await page.getByTestId('transaction-expense').click();await amount('20,000.00')
 await page.getByRole('button',{name:'打开设置'}).click();await page.getByLabel('减少动态效果',{exact:true}).uncheck();await page.getByRole('button',{name:'关闭',exact:true}).click()
 await page.getByLabel('交易金额').fill('980000');await page.getByRole('button',{name:/记入进账/}).click();await amount('1,000,000.00');await settled()
 await page.getByRole('button',{name:'回到初始视角',exact:true}).click();await page.waitForTimeout(1100)
 const large=await inspect();assert.equal(large.personal.gold,50);assert.ok(Math.abs(large.personal.goldScale-.45)<1e-6)
 await page.screenshot({path:'docs/product-screenshots/05-million-personal.png'})
 await page.getByLabel('交易金额').fill('999999.99');await page.getByTestId('transaction-expense').click();await amount('0.01');await settled();await page.waitForTimeout(1100)
 const small=await inspect();assert.equal(small.personal.gold,0);assert.ok(small.camera.position.every(Number.isFinite))
 await page.getByRole('button',{name:'打开设置'}).click();await page.getByLabel('减少动态效果',{exact:true}).check();await page.getByRole('button',{name:'关闭',exact:true}).click()
 for(let i=0;i<12;i++) {
  await page.getByRole('button',{name:'财富尺度',exact:true}).click()
  for(const id of ['1m','musk']){await page.getByTestId('comparison-example-'+id).click();await page.waitForTimeout(70)}
  const snapshot=await inspect();snapshots.push({geometries:snapshot.renderer.geometries,textures:snapshot.renderer.textures})
  await page.getByRole('button',{name:'回到我的小岛',exact:true}).click()
 }
 assert.deepEqual(snapshots.at(-1),snapshots[1])
 await page.getByRole('button',{name:'打开设置'}).click();await page.getByLabel('画面质量',{exact:true}).selectOption('low');await page.getByRole('button',{name:'关闭',exact:true}).click()
 await page.getByRole('button',{name:'财富尺度',exact:true}).click();await page.getByTestId('comparison-example-musk').click();await page.getByRole('button',{name:'回到我的小岛',exact:true}).click()
 await page.getByRole('button',{name:/岛屿手记/}).focus();await page.keyboard.press('Enter');await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});assert.ok(await page.getByRole('button',{name:/岛屿手记/}).evaluate(el=>el===document.activeElement))
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 assert.deepEqual(errors,[])
 const report={at:new Date().toISOString(),browser:browser.version(),viewport:'1180x820 DPR2',checks:['Reduced motion enabled during a real persistence lock wait: late transaction shows its final state immediately','20k to 1m natural transaction: 50 unchanged .45 gold units at 200:1','1m to one cent natural exit: retains exact balance and finite camera','12 comparison round trips: steady geometry/texture counts','Quality switch, reduced motion, keyboard focus, no horizontal overflow'],large,resources:snapshots,errors}
 await writeFile('docs/product-soak-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify({checks:report.checks,resources:snapshots,errors},null,2))
}finally{await browser.close()}

