export const STONE = 10_000 // Integer fen; one small stone = 100 yuan.
export const STONES_PER_GOLD = 200
export const GOLD = STONE * STONES_PER_GOLD
export const DEMO_LIMIT = 100_000_000 // One million yuan, shared by the rendered reserve and ledger.
export const ENTRY_LIMIT = 10_000
export type Entry = { id: string; type: 'income' | 'expense'; amount: number; at: string; note?: string; reverses?: string }
export type Ledger = { schemaVersion: 1; initial: number; initialNote?: string; entries: Entry[] }
export type Transaction = { id: string; type: Entry['type']; amount: number; before: number; after: number }
export const freshLedger = (initial = 80_000, initialNote = ''): Ledger => {
  validateInitial(initial)
  return { schemaVersion: 1, initial, ...(cleanNote(initialNote) ? { initialNote: cleanNote(initialNote) } : {}), entries: [] }
}
export function validateInitial(amount: number) {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > DEMO_LIMIT) throw new Error('储备金额须在 ¥0 至 ¥1,000,000 之间，最多两位小数。')
}
function cleanNote(note: string) {
  if (typeof note !== 'string' || note.length > 120) throw new Error('备注最多 120 个字。')
  return note.trim()
}
export function parseAmount(text: string): number {
  if (!/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/.test(text)) throw new Error('请输入正数金额，最多两位小数。')
  const [yuan, fen = ''] = text.split('.')
  const amount = Number(yuan) * 100 + Number(fen.padEnd(2, '0'))
  if (amount <= 0) throw new Error('金额需要大于 0。')
  if (amount > DEMO_LIMIT) throw new Error('本版储备金额上限为 ¥1,000,000。')
  return amount
}
export function balance(ledger: Ledger) {
  return ledger.entries.reduce((sum, entry) => sum + (entry.type === 'income' ? entry.amount : -entry.amount), ledger.initial)
}
export function transact(ledger: Ledger, type: Entry['type'], amount: number, id: string, note = '', reverses?: string): { ledger: Ledger; transaction: Transaction } {
  if (!['income', 'expense'].includes(type) || !Number.isSafeInteger(amount) || amount <= 0 || typeof id !== 'string' || !id || id.length > 100) throw new Error('金额或记录无效。')
  if (ledger.entries.length >= ENTRY_LIMIT) throw new Error('当前账本已达 10,000 条记录，请先导出备份。')
  if (ledger.entries.some(entry => entry.id === id)) throw new Error('这笔记录已提交。')
  if (reverses) {
    const source = ledger.entries.find(entry => entry.id === reverses)
    if (!source || source.reverses || source.type === type || source.amount !== amount || ledger.entries.some(entry => entry.reverses === reverses)) throw new Error('此记录无法重复撤销。')
  }
  const before = balance(ledger), after = before + (type === 'income' ? amount : -amount)
  if (after < 0) throw new Error('储备余额不足，不能支出或撤销这笔进账。')
  if (after > DEMO_LIMIT) throw new Error('本版储备上限为 ¥1,000,000。')
  const entry: Entry = { id, type, amount, at: new Date().toISOString(), ...(cleanNote(note) ? { note: cleanNote(note) } : {}), ...(reverses ? { reverses } : {}) }
  return { ledger: { ...ledger, entries: [...ledger.entries, entry] }, transaction: { id, type, amount, before, after } }
}
export function reverseEntry(ledger: Ledger, entryId: string, id: string) {
  const entry = ledger.entries.find(value => value.id === entryId)
  if (!entry) throw new Error('未找到这笔记录。')
  return transact(ledger, entry.type === 'income' ? 'expense' : 'income', entry.amount, id, '撤销记录', entry.id)
}
export function validateLedger(value: unknown): Ledger {
  if (!value || typeof value !== 'object') throw new Error('账本格式无效。')
  const data = value as Ledger
  if (data.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.length > ENTRY_LIMIT) throw new Error('账本版本或记录数量无效。')
  const ledger = freshLedger(data.initial, data.initialNote ?? '')
  const seen = new Map<string, Entry>(), reversed = new Set<string>()
  let amount = data.initial
  for (const entry of data.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 100 || seen.has(entry.id) || !['income', 'expense'].includes(entry.type) || !Number.isSafeInteger(entry.amount) || entry.amount <= 0 || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) throw new Error('账本含有无效或重复记录。')
    const note = cleanNote(entry.note ?? '')
    if (entry.reverses !== undefined) {
      const source = seen.get(entry.reverses)
      if (typeof entry.reverses !== 'string' || !source || source.reverses || reversed.has(entry.reverses) || source.type === entry.type || source.amount !== entry.amount) throw new Error('账本撤销链无效。')
      reversed.add(entry.reverses)
    }
    amount += entry.type === 'income' ? entry.amount : -entry.amount
    validateInitial(amount)
    const safe: Entry = { id: entry.id, type: entry.type, amount: entry.amount, at: entry.at, ...(note ? { note } : {}), ...(entry.reverses ? { reverses: entry.reverses } : {}) }
    seen.set(safe.id, safe)
    ledger.entries.push(safe)
  }
  return ledger
}
export function denomination(amount: number) {
  return { gold: Math.floor(amount / GOLD), stones: Math.floor(amount % GOLD / STONE), remainder: amount % STONE }
}
export function money(amount: number) {
  return `${Math.floor(amount / 100).toLocaleString('zh-CN')}.${String(amount % 100).padStart(2, '0')}`
}
export const DEMO_KEY = 'time-island-rebuild:reserve-demo:v1'
