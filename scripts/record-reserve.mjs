import { mkdir } from 'node:fs/promises'
import path from 'node:path'

process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve('.browser-tools')
const { chromium } = await import('playwright')

await mkdir('docs/reserve-recordings',{recursive:true})
const browser=await chromium.launch({channel:'chrome',headless:true})
const context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:'docs/reserve-recordings',size:{width:1440,height:1000}},reducedMotion:'no-preference'})
const page=await context.newPage()
try {
 await page.goto('http://127.0.0.1:5186/',{waitUntil:'networkidle'})
 await page.getByText('三维小岛加载完成',{exact:true}).waitFor()
 await page.getByRole('button',{name:'近看',exact:true}).click()
 await page.waitForTimeout(600)
 await page.getByRole('button',{name:/看进账合成/}).click()
 await page.getByRole('button',{name:'跳过动画',exact:true}).waitFor({state:'detached',timeout:12000})
 await page.waitForTimeout(700)
 await page.getByRole('button',{name:/看出账拆分/}).click()
 await page.getByTestId('motion-status').filter({hasText:'金矿裂开'}).waitFor()
 await page.waitForTimeout(360)
 await page.screenshot({path:'docs/reserve-screenshots/physics-cracks.png'})
 await page.waitForTimeout(550)
 await page.screenshot({path:'docs/reserve-screenshots/physics-fragments.png'})
 await page.getByRole('button',{name:'跳过动画',exact:true}).waitFor({state:'detached',timeout:12000})
 await page.waitForTimeout(1100)
 await context.close()
 await page.video().saveAs('docs/reserve-physics-demo.webm')
 console.log('Saved docs/reserve-physics-demo.webm: 800 → 1000 → 750, actual browser capture.')
} finally {await browser.close()}
