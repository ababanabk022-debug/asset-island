import assert from 'node:assert/strict'
import { parseAmount, transact, freshLedger, balance, denomination, validateLedger, DEMO_LIMIT, STONE, GOLD, STONES_PER_GOLD } from '../src/domain/reserve.ts'
import { makeMotion, restingPieces, SMALL_SCALE } from '../src/scene/reserveMotion.ts'

assert.equal(parseAmount('0.01'),1)
assert.equal(parseAmount('250.50'),25050)
for(const text of ['', '-1', '1e3', 'NaN', 'Infinity', '1.234', '.5', '00.1','0', '1000000.01',' 1 ']) assert.throws(()=>parseAmount(text),text)
const state=freshLedger()
assert.equal(STONES_PER_GOLD, 200)
assert.equal(GOLD, 2_000_000)
assert.equal(SMALL_SCALE, .45, 'Changing denomination leaves full-size gold geometry unchanged')
assert.deepEqual(denomination(100000),{gold:0,stones:10,remainder:0},'Old balances retain their value under the new visual denomination')
const legacy = { schemaVersion: 1, initial: 80_000, entries: [
  { id: 'old-income', type: 'income', amount: 420_000, at: '2026-10-01T00:00:00.000Z', note: '旧金矿面额不修改账本' },
  { id: 'old-expense', type: 'expense', amount: 25_000, at: '2026-10-02T00:00:00.000Z' },
] }
assert.deepEqual(validateLedger(legacy), legacy, 'Existing dates, amounts and notes survive unchanged; no ledger migration')
assert.equal(balance(legacy),475_000)
assert.deepEqual(denomination(balance(legacy)),{gold:0,stones:47,remainder:5000})
let result=transact(state,'income',GOLD-balance(state),'merge')
assert.equal(balance(result.ledger),GOLD)
assert.deepEqual(denomination(balance(result.ledger)),{gold:1,stones:0,remainder:0})
assert.throws(()=>transact(result.ledger,'income',1,'merge'))
result=transact(result.ledger,'expense',1,'split')
assert.equal(balance(result.ledger),GOLD-1)
assert.deepEqual(denomination(balance(result.ledger)),{gold:0,stones:STONES_PER_GOLD-1,remainder:STONE-1})
assert.throws(()=>transact(result.ledger,'expense',GOLD,'overdraw'))
assert.throws(()=>transact(result.ledger,'income',DEMO_LIMIT,'overlimit'))
assert.equal(balance(validateLedger(JSON.parse(JSON.stringify(result.ledger)))),GOLD-1)
assert.throws(()=>validateLedger({...result.ledger,entries:[...result.ledger.entries,result.ledger.entries[0]]}))
assert.throws(()=>validateLedger({...result.ledger,entries:[{id:'x',amount:Infinity,type:'income',at:new Date().toISOString()}]}))
assert.deepEqual(denomination(GOLD-STONE),{gold:0,stones:STONES_PER_GOLD-1,remainder:0})
assert.deepEqual(denomination(DEMO_LIMIT),{gold:50,stones:0,remainder:0})
assert.deepEqual(denomination(DEMO_LIMIT-1),{gold:49,stones:199,remainder:9999})

const volume=pieces=>pieces.reduce((total,piece)=>total+piece.value*piece.factor,0)
let cases=0
for(const before of [0,1,STONE-1,STONE,75000,80000,100000,499999,500000,GOLD-STONE,GOLD-1,GOLD,GOLD+1,2*GOLD-1,2*GOLD,DEMO_LIMIT-GOLD,DEMO_LIMIT-1,DEMO_LIMIT]) {
  assert.equal(volume(restingPieces(before)),before)
  for(const amount of [1,STONE-1,STONE,25000,100000,GOLD-1,GOLD,GOLD+1,DEMO_LIMIT]) {
    for(const type of ['income','expense']) {
      const after=before+(type==='income'?amount:-amount)
      if(after<0||after>DEMO_LIMIT) continue
      const plan=makeMotion({id:`${before}-${type}-${amount}`,type,before,after,amount})
      assert.equal(volume(plan.fixed)+volume(plan.pool),type==='income'?after:before)
      assert.equal(volume(plan.fixed)+plan.fragments.filter(f=>f.target).reduce((n,f)=>n+f.value,0),after)
      assert.equal(plan.fragments.filter(f=>!f.target).reduce((n,f)=>n+f.value,0),type==='expense'?amount:0)
      assert.ok(plan.fragments.every(f=>Number.isSafeInteger(f.value)&&f.value>0))
      assert.ok(plan.pool.length+plan.targets.length<=2*Math.floor(DEMO_LIMIT/GOLD)+3*STONES_PER_GOLD, 'Allocation bounds include old loose stones, new/split stones and final change')
      cases++
    }
  }
}
console.log(`Money parsing, unchanged legacy ledger replay, overdraft/limit validation, 200:1 denomination, one-fen gold split and ${cases} denomination-allocation cases passed.`)
