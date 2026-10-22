import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { ReservePhysics, physicsReady, PHYSICS_SECONDS, INCOME_COMPLETE_AT, EXPENSE_DEPART_AT } from '../src/scene/reservePhysics.ts'
import { makeMotion, restingPieces } from '../src/scene/reserveMotion.ts'
import { physicsFixture } from './physics-fixture.mjs'

await physicsReady
assert.ok(PHYSICS_SECONDS <= 1.8, 'Interactive batch completes within 1.8 seconds without time scaling')
assert.ok(INCOME_COMPLETE_AT < 1, 'Conversion occurs in the first second')
const assets = await physicsFixture()
const report = []
const value = pieces => pieces.reduce((n,p)=>n+p.value*p.factor,0)
function run(before,type,amount,initial) {
  const after = before+(type==='income'?amount:-amount)
  const sim = new ReservePhysics(assets,initial??restingPieces(before),makeMotion({id:'physics-test',before,after,type,amount}))
  let maxCount=0, contacts=0, rotation=0
  const start=performance.now()
  for(let i=0;i<Math.ceil(PHYSICS_SECONDS*90)+1;i++) {
    sim.advance(1/90)
    const pieces=sim.pieces(),t=sim.time
    maxCount=Math.max(maxCount,pieces.length);contacts=Math.max(contacts,sim.impacts.length)
    for(const p of pieces) {
      assert.ok([...p.position,...p.orientation].every(Number.isFinite),'Finite six-axis poses')
      assert.ok(p.position[1]>-1,`No reserve falls through terrain: ${before} ${type} ${amount}, t=${t}, ${JSON.stringify(p)}`)
      rotation=Math.max(rotation,Math.abs(p.orientation[0])+Math.abs(p.orientation[2]))
    }
    if(type==='income'&&t>.2||type==='expense'&&t<EXPENSE_DEPART_AT) assert.ok(Math.abs(value(pieces)-(type==='income'?after:before))<.001,'Conversion preserves represented volume')
    assert.ok(pieces.length<440,'No instance truncation')
    if(type==='income' && t >= .05) assert.ok(value(pieces) > before, 'Income reacts within 50ms of simulation time')
    if(type==='expense' && !sim.plan.brokenGold.length && t >= .08 && t < .12) assert.ok(sim.bodies.some(b => b.spent && (b.lifted || b.launched)), 'Simple expense reacts within 80ms of simulation time')
  }
  const final = sim.pieces()
  assert.ok(Math.abs(value(final)-after)<.001,`Final amount ${before} ${type} ${amount}: ${value(final)} != ${after}`)
  assert.equal(final.length,restingPieces(after).length,'Visible denominations match the balance panel')
  for (const p of final) assert.ok(p.position[1]>.45 && Math.abs(p.position[0])<4.5 && p.position[2]<3.9,`Retained reserve stays on visible island terrace: ${before} ${type} ${amount}: ${JSON.stringify(p)}`)
  const maxSpeed=Math.max(0,...sim.bodies.map(b=>{const v=b.body.linvel();return Math.hypot(v.x,v.y,v.z)}))
  assert.ok(maxSpeed<.25,`Final bodies settle, ${before} ${type} ${amount} speed=${maxSpeed}`)
  report.push({before,type,amount,after,simulationSeconds:sim.time,maxCount,contacts,rotation,maxSpeed,computeMs:Math.round(performance.now()-start)})
  sim.dispose()
  return final
}
const gold=run(80000,'income',20000)
const stones=run(100000,'expense',25000,gold)
run(75000,'income',25000,stones)
run(100000,'expense',1)
run(100000,'expense',100000)
run(75000,'income',1925000)
run(2000000,'expense',2000000)
run(0,'income',1)
run(105001,'expense',5002)
for (const before of [0,1,9999,10000,75000,80000,99999,100000,105001,199999,900000,1999999,2000000]) {
  for (const amount of [1,5000,20000,25000,100000,200000,999999,2000000]) for (const type of ['income','expense']) {
    const after=before+(type==='income'?amount:-amount)
    if(after>=0&&after<=2000000) run(before,type,amount)
  }
}
// Also exercise consecutive real settled poses and a reused WASM world.
// Importing here keeps the chain in the normal npm test regression suite.
await import('./test-reserve-chain.mjs')
await writeFile('docs/physics-check.json',JSON.stringify({engine:'Rapier 0.12.0',step:1/90,batchSeconds:PHYSICS_SECONDS,realExportedColliders:true,cases:report},null,2))
console.log(JSON.stringify(report,null,2))
