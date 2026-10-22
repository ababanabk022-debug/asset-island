import assert from 'node:assert/strict'
import { balance, DEMO_LIMIT, freshLedger, parseAmount, reverseEntry, transact, validateLedger } from '../src/domain/reserve.ts'
import { commitPersonal, makeBackup, MAX_BACKUP_BYTES, parseBackup, PERSONAL_KEY, preferredMode, readPersonal, replacePersonal } from '../src/storage/ledgerStore.ts'

let checks = 0
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`) }
async function asyncCheck(name, fn) { await fn(); checks++; console.log(`PASS ${name}`) }
const base = freshLedger(12345, '工资结余')
check('new tabs find existing personal storage while respecting explicit demo choice', () => {
  assert.equal(preferredMode(null, false), 'demo')
  assert.equal(preferredMode(null, true), 'personal')
  assert.equal(preferredMode('demo', true), 'demo')
  assert.equal(preferredMode('personal', false), 'personal')
  assert.equal(preferredMode('unknown', true), 'personal')
  // Existing raw bytes include malformed data: opening personal exposes recovery.
  const corruptStorage = new Map([[PERSONAL_KEY, '{broken']])
  assert.equal(preferredMode(null, (corruptStorage.get(PERSONAL_KEY) ?? null) !== null), 'personal')
})
check('integer cents, exact parsing and upper bound', () => {
  assert.equal(parseAmount('0.01'), 1)
  assert.equal(parseAmount('1000000.00'), DEMO_LIMIT)
  for (const value of ['1.001', '1e3', '-1', '0', '1000000.01', '01', 'NaN']) assert.throws(() => parseAmount(value))
  assert.equal(balance(base), 12345)
  assert.equal(freshLedger(0).initial, 0)
  assert.throws(() => freshLedger(-1))
  assert.throws(() => freshLedger(0.1))
})
const income = transact(base, 'income', 1, 'in-1', '一分钱')
const expense = transact(income.ledger, 'expense', 46, 'out-1')
check('income expense preserve exact sums and original ledger', () => {
  assert.equal(balance(expense.ledger), 12300)
  assert.equal(balance(base), 12345)
  assert.equal(income.ledger.entries[0].note, '一分钱')
  assert.throws(() => transact(expense.ledger, 'income', 2, 'in-1'))
  assert.throws(() => transact(expense.ledger, 'expense', 12301, 'overdraft'))
  assert.throws(() => transact(freshLedger(DEMO_LIMIT), 'income', 1, 'overflow'))
  assert.throws(() => transact(base, 'other', 1, 'bad'))
})
const reversal = reverseEntry(expense.ledger, 'out-1', 'undo-1')
check('undo is an auditable opposite entry, never deletes history', () => {
  assert.equal(balance(reversal.ledger), 12346)
  assert.equal(reversal.ledger.entries.length, 3)
  assert.equal(reversal.ledger.entries[2].reverses, 'out-1')
  assert.throws(() => reverseEntry(reversal.ledger, 'out-1', 'undo-2'))
  assert.throws(() => reverseEntry(reversal.ledger, 'undo-1', 'undo-3'))
  assert.throws(() => reverseEntry(reversal.ledger, 'missing', 'undo-4'))
  const spent = transact(transact(freshLedger(0), 'income', 100, 'earned').ledger, 'expense', 100, 'spent').ledger
  assert.throws(() => reverseEntry(spent, 'earned', 'cannot'))
})
check('ledger validation retains dates and rejects forged reversal chains', () => {
  assert.deepEqual(validateLedger(JSON.parse(JSON.stringify(reversal.ledger))), reversal.ledger)
  const e = reversal.ledger.entries[2]
  for (const modified of [{ ...e, reverses: 'missing' }, { ...e, amount: 47 }, { ...e, type: 'expense' }, { ...e, at: 'invalid' }]) {
    assert.throws(() => validateLedger({ ...expense.ledger, entries: [...expense.ledger.entries, modified] }))
  }
  assert.throws(() => validateLedger({ ...base, entries: [income.ledger.entries[0], income.ledger.entries[0]] }))
  assert.throws(() => validateLedger({ ...base, initial: Infinity }))
  assert.throws(() => validateLedger({ ...base, initialNote: '<'.repeat(121) }))
})
const backup = makeBackup(reversal.ledger)
check('backup preview round trip, rejecting foreign or damaged files', () => {
  const preview = parseBackup(backup)
  assert.equal(preview.amount, 12346)
  assert.equal(preview.entries, 3)
  assert.deepEqual(preview.ledger, reversal.ledger)
  for (const bad of ['{}', 'null', '[1]', '{bad', backup.replace('time-island-reserve', 'other'), backup.replace('"version": 1', '"version": 9'), ' '.repeat(MAX_BACKUP_BYTES + 1)]) assert.throws(() => parseBackup(bad))
})
const values = new Map()
const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
let queue = Promise.resolve()
const lock = task => { const result = queue.then(task); queue = result.catch(() => {}); return result }
let saved
await asyncCheck('durable initialization and reload exact ledger', async () => {
  assert.equal(readPersonal(storage), null)
  saved = await commitPersonal(storage, lock, null, base)
  assert.deepEqual(readPersonal(storage), saved)
  assert.ok(saved.revision)
})
await asyncCheck('quota failure leaves stored balance and revision unchanged', async () => {
  const broken = { getItem: storage.getItem, setItem: () => { throw new Error('QuotaExceededError') } }
  await assert.rejects(commitPersonal(broken, lock, saved.revision, income.ledger))
  assert.deepEqual(readPersonal(storage), saved)
})
await asyncCheck('concurrent tabs cannot overwrite: one wins, one must reload', async () => {
  const results = await Promise.allSettled([
    commitPersonal(storage, lock, saved.revision, income.ledger),
    commitPersonal(storage, lock, saved.revision, expense.ledger),
  ])
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(results.filter(value => value.status === 'rejected').length, 1)
  assert.equal(balance(readPersonal(storage).ledger), 12346)
  await assert.rejects(commitPersonal(storage, lock, null, freshLedger(0)))
})
await asyncCheck('invalid import cannot replace existing data', async () => {
  const before = storage.getItem(PERSONAL_KEY)
  await assert.rejects(commitPersonal(storage, lock, readPersonal(storage).revision, { ...base, initial: -1 }))
  assert.equal(storage.getItem(PERSONAL_KEY), before)
  const preview = parseBackup(backup)
  assert.equal(storage.getItem(PERSONAL_KEY), before, 'preview is read only')
  const applied = await commitPersonal(storage, lock, readPersonal(storage).revision, preview.ledger)
  assert.deepEqual(applied.ledger, reversal.ledger)
})
await asyncCheck('unavailable locks and unreadable storage preserve data', async () => {
  const before = storage.getItem(PERSONAL_KEY)
  await assert.rejects(commitPersonal(storage, () => Promise.reject(new Error('lock unavailable')), readPersonal(storage).revision, base))
  assert.equal(storage.getItem(PERSONAL_KEY), before)
  const denied = { getItem: () => { throw new Error('SecurityError') }, setItem: () => assert.fail('must not write') }
  assert.throws(() => readPersonal(denied))
  await assert.rejects(commitPersonal(denied, lock, null, base))
})
await asyncCheck('corrupt persistence is never overwritten silently', async () => {
  values.set(PERSONAL_KEY, '{broken')
  assert.throws(() => readPersonal(storage))
  await assert.rejects(commitPersonal(storage, lock, null, base))
  assert.equal(storage.getItem(PERSONAL_KEY), '{broken')
})
await asyncCheck('confirmed valid backup can recover corrupt persistence atomically', async () => {
  const before = storage.getItem(PERSONAL_KEY)
  const preview = parseBackup(backup)
  assert.equal(storage.getItem(PERSONAL_KEY), before)
  await assert.rejects(replacePersonal(storage, lock, before, { ...base, initial: -1 }))
  assert.equal(storage.getItem(PERSONAL_KEY), before)
  const denied = { getItem: storage.getItem, setItem: () => { throw new Error('QuotaExceededError') } }
  await assert.rejects(replacePersonal(denied, lock, before, preview.ledger))
  assert.equal(storage.getItem(PERSONAL_KEY), before)
  const restored = await replacePersonal(storage, lock, before, preview.ledger)
  assert.deepEqual(readPersonal(storage), restored)
})
await asyncCheck('confirmed import refuses data changed after its preview', async () => {
  const before = storage.getItem(PERSONAL_KEY)
  const newer = await commitPersonal(storage, lock, readPersonal(storage).revision, base)
  await assert.rejects(replacePersonal(storage, lock, before, reversal.ledger))
  assert.deepEqual(readPersonal(storage), newer)
})
check('largest supported record count and notes exports into an importable UTF-8 file', () => {
  const ledger = { ...freshLedger(0), entries: Array.from({ length: 10000 }, (_, i) => ({ id: `record-${i}`, type: 'income', amount: 1, at: new Date().toISOString(), note: '储'.repeat(120) })) }
  const text = makeBackup(ledger)
  assert.ok(new TextEncoder().encode(text).byteLength > 2_000_000)
  assert.ok(new TextEncoder().encode(text).byteLength < MAX_BACKUP_BYTES)
  assert.equal(parseBackup(text).entries, 10000)
  assert.throws(() => parseBackup('储'.repeat(Math.ceil(MAX_BACKUP_BYTES / 3))))
})
console.log(`Ledger acceptance: ${checks} scenarios passed.`)
