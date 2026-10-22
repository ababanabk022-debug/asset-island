import assert from 'node:assert/strict'
import { balance, freshLedger, reverseEntry, transact } from '../src/domain/reserve.ts'
import { commitPresentation, completePresentation, createPresentation, snapPresentation, PRESENTATION_EVENT_LIMIT } from '../src/domain/reservePresentation.ts'
import { commitPersonal, PERSONAL_KEY, readPersonal } from '../src/storage/ledgerStore.ts'

let ledger = freshLedger()
let shown = createPresentation(balance(ledger))
const commit = (type, amount, id, animate = true) => {
  const next = transact(ledger, type, amount, id)
  ledger = next.ledger
  shown = commitPresentation(shown, balance(ledger), next.transaction, animate, shown.generation)
  return next.transaction
}

const first = commit('income', 20_000, 'first')
assert.equal(shown.visualAmount, 100_000)
assert.deepEqual(shown.transaction, first)
const events = [first]
for (let i = 0; i < 100; i++) events.push(commit(i % 3 === 0 ? 'expense' : 'income', 100, `rapid-${i}`))
assert.equal(ledger.entries.length, 101, 'all successful clicks create distinct ledger entries')
assert.equal(balance(ledger), 103_200)
assert.equal(shown.visualAmount, balance(ledger), 'the live world always receives the latest committed balance')
assert.deepEqual(shown.transactions, events, 'every commit reaches the live scene in order, including opposite directions')
assert.deepEqual(shown.transaction, events.at(-1), 'the latest event remains available to existing status consumers')
assert.equal(shown.generation, 0, 'ordinary commits never reset the live world')

shown = completePresentation(shown, 'rapid-49')
assert.deepEqual(shown.transactions, events.slice(51), 'acknowledgement only retires the consumed prefix')
assert.equal(shown.transaction.id, 'rapid-99')
assert.strictEqual(completePresentation(shown, first.id), shown, 'a late older acknowledgement cannot retire newer events')
assert.strictEqual(completePresentation(shown, 'never-committed'), shown, 'an unknown callback cannot advance the stream')
const during = commit('expense', 200, 'during-consumption')
shown = completePresentation(shown, 'rapid-99')
assert.deepEqual(shown.transactions, [during])
assert.equal(shown.visualAmount, balance(ledger))
shown = completePresentation(shown, during.id)
assert.equal(shown.transaction, null)
assert.deepEqual(shown.transactions, [])
assert.equal(shown.visualAmount, balance(ledger))

const plus = commit('income', 20_000, 'opposite-plus')
const minus = commit('expense', 20_000, 'opposite-minus')
assert.deepEqual(shown.transactions, [plus, minus], 'opposite entries are both shown rather than erased by netting')
assert.equal(shown.visualAmount, minus.after)
assert.equal(ledger.entries.at(-2).id, plus.id)
assert.equal(ledger.entries.at(-1).id, minus.id)
shown = completePresentation(shown, minus.id)
assert.deepEqual(shown.transactions, [])
assert.strictEqual(completePresentation(shown, plus.id), shown, 'out-of-order acknowledgement after a later prefix is harmless')

const expense = commit('expense', 20_000, 'undo-source')
const reversed = reverseEntry(ledger, expense.id, 'undo-reversal')
ledger = reversed.ledger
shown = commitPresentation(shown, balance(ledger), reversed.transaction, true, shown.generation)
assert.deepEqual(shown.transactions, [expense, reversed.transaction], 'undo is a separate income event during the original outflow')
assert.equal(shown.transaction.id, 'undo-reversal')
shown = completePresentation(shown, expense.id)
assert.deepEqual(shown.transactions, [reversed.transaction])

commit('income', 500, 'before-skip')
shown = snapPresentation(shown, balance(ledger))
assert.equal(shown.transaction, null)
assert.deepEqual(shown.transactions, [])
assert.equal(shown.visualAmount, balance(ledger))
assert.strictEqual(completePresentation(shown, 'undo-reversal'), shown)

commit('income', 100, 'reduced-active')
commit('expense', 200, 'reduced-latest')
commit('income', 300, 'reduced-snap', false)
assert.equal(shown.transaction, null)
assert.deepEqual(shown.transactions, [])
assert.equal(shown.visualAmount, balance(ledger), 'reduced motion snaps to the full committed ledger')

commit('income', 100, 'mode-old')
commit('income', 200, 'mode-latest')
shown = snapPresentation(shown, 5_000)
assert.equal(shown.visualAmount, 5_000)
assert.deepEqual(shown.transactions, [])
assert.strictEqual(completePresentation(shown, 'mode-old'), shown, 'old mode callbacks cannot alter the replacement ledger')

// A stalled consumer must not create an unbounded journal. Snap the visual
// snapshot only; all 129 saved entries remain present in the accounting ledger.
ledger = freshLedger()
shown = createPresentation(balance(ledger))
for (let i = 0; i < PRESENTATION_EVENT_LIMIT; i++) commit('income', 1, `bounded-${i}`)
assert.equal(shown.transactions.length, PRESENTATION_EVENT_LIMIT)
commit('income', 1, 'bounded-overflow')
assert.equal(ledger.entries.length, PRESENTATION_EVENT_LIMIT + 1)
assert.equal(shown.visualAmount, balance(ledger))
assert.equal(shown.generation, 1)
assert.deepEqual(shown.transactions, [])
assert.equal(shown.transaction, null)
assert.strictEqual(completePresentation(shown, 'bounded-127'), shown)
const afterOverflow = commit('expense', 1, 'after-overflow')
assert.deepEqual(shown.transactions, [afterOverflow], 'normal streaming resumes immediately after a bounded full sync')
const inconsistent = { id: 'gap', type: 'income', before: 0, after: 100, amount: 100 }
const recovered = commitPresentation(shown, 100, inconsistent, true, shown.generation)
assert.equal(recovered.generation, shown.generation + 1, 'a discontinuous scene event safely requests a fresh authoritative snapshot')
assert.equal(recovered.visualAmount, 100)
assert.deepEqual(recovered.transactions, [])

// Exercise the save-before-animation boundary through the hook's storage port.
const values = new Map()
let failWrite = false
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => { if (failWrite) throw new Error('quota'); values.set(key, value) },
}
const lock = async task => task()
let durable = await commitPersonal(storage, lock, null, freshLedger())
shown = createPresentation(balance(durable.ledger))
async function save(type, amount, id, heldLock = lock) {
  const next = transact(durable.ledger, type, amount, id)
  const generation = shown.generation
  const saved = await commitPersonal(storage, heldLock, durable.revision, next.ledger)
  durable = saved
  shown = commitPresentation(shown, balance(saved.ledger), next.transaction, true, generation)
}
await save('income', 20_000, 'saved-income')
await save('expense', 100, 'saved-expense')
const beforeFailure = shown
const durableBeforeFailure = storage.getItem(PERSONAL_KEY)
failWrite = true
await assert.rejects(save('income', 300, 'failed'), /quota/)
assert.strictEqual(shown, beforeFailure, 'a failed save creates no event and leaves already saved motion intact')
assert.equal(storage.getItem(PERSONAL_KEY), durableBeforeFailure)
assert.equal(balance(durable.ledger), 99_900)
failWrite = false
shown = completePresentation(shown, 'saved-income')
assert.equal(shown.transaction.after, 99_900)
assert.equal(shown.transactions.length, 1)

let release
const delayedLock = task => new Promise(resolve => { release = () => resolve(task()) })
const writing = save('income', 200, 'save-after-skip', delayedLock)
shown = snapPresentation(shown, balance(durable.ledger))
release()
await writing
assert.equal(balance(durable.ledger), 100_100)
assert.equal(shown.visualAmount, 100_100)
assert.equal(shown.transaction, null, 'a save finishing after skip/background/comparison must stay snapped')
assert.deepEqual(shown.transactions, [])

const external = await commitPersonal(storage, lock, durable.revision, transact(durable.ledger, 'income', 700, 'other-tab').ledger)
await assert.rejects(save('expense', 100, 'stale-write'), /另一标签页/)
assert.equal(readPersonal(storage).revision, external.revision)
assert.equal(balance(readPersonal(storage).ledger), 100_800)
shown = snapPresentation(shown, balance(external.ledger))
assert.equal(shown.transaction, null)
assert.equal(shown.visualAmount, 100_800)

console.log('Live presentation stream: 101 ordered rapid commits, opposite entries, undo, prefix/stale acknowledgements, bounded 129-entry full sync, skip, reduced motion, mode replacement, failed write, delayed save and revision conflict passed.')
