import { balance, validateLedger, type Ledger } from '../domain/reserve.ts'

export const PERSONAL_KEY = 'time-island-rebuild:personal:v1'
export const MAX_BACKUP_BYTES = 8_000_000
export type Snapshot = { revision: string; ledger: Ledger }
export type BackupPreview = { amount: number; initial: number; entries: number; exportedAt: string; ledger: Ledger }
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
export type LockPort = <T>(task: () => Promise<T> | T) => Promise<T>
export function preferredMode(sessionChoice: string | null, personalExists: boolean): 'demo' | 'personal' {
  if (sessionChoice === 'demo' || sessionChoice === 'personal') return sessionChoice
  return personalExists ? 'personal' : 'demo'
}
export function readPersonal(storage: StoragePort): Snapshot | null {
  const raw = storage.getItem(PERSONAL_KEY)
  if (raw === null) return null
  const value = JSON.parse(raw)
  if (!value || value.schemaVersion !== 1 || typeof value.revision !== 'string' || !value.revision) throw new Error('个人账本损坏，已停止写入。请保留浏览器数据并检查备份。')
  return { revision: value.revision, ledger: validateLedger(value.ledger) }
}
export async function commitPersonal(storage: StoragePort, lock: LockPort, expectedRevision: string | null, ledger: Ledger): Promise<Snapshot> {
  // Every writer checks the revision while holding the same origin-wide lock.
  return lock(() => {
    const current = readPersonal(storage)
    if ((current?.revision ?? null) !== expectedRevision) throw new Error('另一标签页更新了账本。请重新打开「我的储备」，核对最新余额后重试。')
    const next = { revision: crypto.randomUUID(), ledger: validateLedger(ledger) }
    storage.setItem(PERSONAL_KEY, JSON.stringify({ schemaVersion: 1, ...next }))
    return next
  })
}
/** Only called after the user has previewed a valid backup and confirmed replacement.
 * Compare exact persisted bytes, so even a damaged ledger cannot be replaced if
 * another tab changed it after preview. Reading failure never authorizes a write. */
export async function replacePersonal(storage: StoragePort, lock: LockPort, expectedRaw: string | null, ledger: Ledger): Promise<Snapshot> {
  return lock(() => {
    if (storage.getItem(PERSONAL_KEY) !== expectedRaw) throw new Error('另一标签页更新了账本。请重新预览备份后确认。')
    const next = { revision: crypto.randomUUID(), ledger: validateLedger(ledger) }
    storage.setItem(PERSONAL_KEY, JSON.stringify({ schemaVersion: 1, ...next }))
    return next
  })
}
export const browserLock: LockPort = task => {
  if (!navigator.locks) return Promise.reject(new Error('此浏览器不支持安全保存，请使用新版 Chrome、Edge 或 Safari，并通过 localhost 或 HTTPS 打开。'))
  return navigator.locks.request(PERSONAL_KEY, task)
}
export function makeBackup(ledger: Ledger): string {
  return JSON.stringify({ format: 'time-island-reserve', version: 1, exportedAt: new Date().toISOString(), ledger: validateLedger(ledger) }, null, 2)
}
export function parseBackup(text: string): BackupPreview {
  if (text.length > MAX_BACKUP_BYTES || new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('备份文件过大，最多支持 8 MB。')
  let value
  try { value = JSON.parse(text) } catch { throw new Error('这不是有效的 JSON 备份。') }
  if (!value || value.format !== 'time-island-reserve' || value.version !== 1 || typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) throw new Error('备份格式或版本无效，请选择本网站导出的备份。')
  const ledger = validateLedger(value.ledger)
  return { amount: balance(ledger), initial: ledger.initial, entries: ledger.entries.length, exportedAt: value.exportedAt, ledger }
}
