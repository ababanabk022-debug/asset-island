import { useCallback, useEffect, useRef, useState } from 'react'
import { balance, DEMO_KEY, freshLedger, reverseEntry, transact, validateLedger, type Entry, type Ledger, type Transaction } from '../domain/reserve'
import { commitPresentation, completePresentation, createPresentation, snapPresentation, type ReservePresentation } from '../domain/reservePresentation'
import { PERSONAL_KEY, browserLock, commitPersonal, makeBackup, parseBackup, preferredMode, readPersonal, replacePersonal, type BackupPreview } from '../storage/ledgerStore'

type Mode = 'demo' | 'personal'
const MODE_KEY = 'time-island-rebuild:mode'
type Saved = { mode: Mode; ledger: Ledger; revision: string | null; initialized: boolean; error: string; damaged: boolean }
function readSaved(mode: Mode): Saved {
  try {
    if (mode === 'personal') {
      const saved = readPersonal(localStorage)
      return { mode, ledger: saved?.ledger ?? freshLedger(0), revision: saved?.revision ?? null, initialized: !!saved, error: '', damaged: false }
    }
    const raw = sessionStorage.getItem(DEMO_KEY)
    return { mode, ledger: raw ? validateLedger(JSON.parse(raw)) : freshLedger(), revision: null, initialized: true, error: '', damaged: false }
  } catch { return { mode, ledger: freshLedger(mode === 'demo' ? 80_000 : 0), revision: null, initialized: false, error: mode === 'demo' ? '体验记录无法读取，请重置体验后再试。' : '个人账本无法读取，已停止记账。可在岛屿手记中导入有效备份恢复；没有备份时请保留浏览器数据并检查存储权限。', damaged: true } }
}
function initialState() {
  let choice: string | null = null
  try { choice = sessionStorage.getItem(MODE_KEY) } catch { /* The personal ledger may still be available. */ }
  if (choice === 'demo' || choice === 'personal') return readSaved(choice)
  try { return readSaved(preferredMode(choice, localStorage.getItem(PERSONAL_KEY) !== null)) }
  catch { return { ...readSaved('personal'), error: '无法读取本机储备。请检查浏览器存储权限；已有账本不会被覆盖。', damaged: true } }
}
export function useReserveDemo() {
  const [saved, setSaved] = useState(initialState)
  const [error, setError] = useState(saved.error)
  const [presentation, setPresentation] = useState(() => createPresentation(balance(saved.ledger)))
  const [busy, setBusy] = useState(false)
  const [importPreview, setImportPreview] = useState<BackupPreview | null>(null)
  const committed = useRef(saved)
  const pending = useRef(false)
  const shown = useRef(presentation)
  const preview = useRef<{ data: BackupPreview; revision: string | null; raw: string | null } | null>(null)
  const updatePresentation = useCallback((next: ReservePresentation) => { shown.current = next; setPresentation(next) }, [])
  const finish = useCallback((id?: string) => {
    updatePresentation(id === undefined
      ? snapPresentation(shown.current, balance(committed.current.ledger))
      : completePresentation(shown.current, id))
  }, [updatePresentation])
  const cancelImport = useCallback(() => { preview.current = null; setImportPreview(null) }, [])
  const apply = useCallback((value: Saved) => { committed.current = value; setSaved(value); setError(value.error) }, [])
  const replaceSaved = useCallback((value: Saved) => {
    apply(value)
    updatePresentation(snapPresentation(shown.current, balance(value.ledger)))
  }, [apply, updatePresentation])
  const switchMode = useCallback(async (mode: Mode) => {
    if (pending.current) return false
    cancelImport()
    const next = readSaved(mode)
    replaceSaved(next)
    try { sessionStorage.setItem(MODE_KEY, mode) } catch { /* Mode choice is optional; ledger writes remain strict. */ }
    return !next.damaged
  }, [replaceSaved, cancelImport])
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if ((event.key === PERSONAL_KEY || event.key === null) && committed.current.mode === 'personal' && !pending.current) {
        cancelImport(); replaceSaved(readSaved('personal'))
      }
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [replaceSaved, cancelImport])
  const persist = useCallback(async (next: Ledger, motion: Transaction | null, reduced: boolean, permitNew = false, replacement?: { raw: string | null }) => {
    const current = committed.current
    if (pending.current || (current.damaged && !replacement) || (!current.initialized && !permitNew)) return false
    const writeGeneration = shown.current.generation
    pending.current = true; setBusy(true)
    try {
      let revision = current.revision
      if (current.mode === 'personal') revision = (await (replacement
        ? replacePersonal(localStorage, browserLock, replacement.raw, next)
        : commitPersonal(localStorage, browserLock, current.revision, next))).revision
      else sessionStorage.setItem(DEMO_KEY, JSON.stringify(next))
      apply({ ...current, ledger: next, revision, initialized: true, damaged: false, error: '' })
      cancelImport()
      updatePresentation(commitPresentation(shown.current, balance(next), motion, !reduced, writeGeneration))
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/另一标签页/.test(message) && current.mode === 'personal') {
        // The storage event can arrive while this write is pending. Refresh here
        // as well so the failed writer is immediately usable with the latest data.
        replaceSaved(readSaved('personal')); cancelImport()
      }
      setError(/另一标签页|不支持安全保存|账本|储备|金额/.test(message) ? message : '保存失败，余额未改变。请检查浏览器存储权限或空间。')
      return false
    } finally { pending.current = false; setBusy(false) }
  }, [apply, replaceSaved, cancelImport, updatePresentation])
  const submit = useCallback(async (type: Entry['type'], amount: number, reduced: boolean, note = '') => {
    if (pending.current) return false
    try {
      const next = transact(committed.current.ledger, type, amount, crypto.randomUUID(), note)
      return await persist(next.ledger, next.transaction, reduced)
    } catch (err) { setError(err instanceof Error ? err.message : '记账失败。'); return false }
  }, [persist])
  const undo = useCallback(async (entryId: string, reduced = false) => {
    if (pending.current) return false
    try {
      const next = reverseEntry(committed.current.ledger, entryId, crypto.randomUUID())
      return await persist(next.ledger, next.transaction, reduced)
    } catch (err) { setError(err instanceof Error ? err.message : '撤销失败。'); return false }
  }, [persist])
  const initialize = useCallback(async (amount: number, note = '') => {
    if (committed.current.mode !== 'personal' || committed.current.initialized) return false
    try { return await persist(freshLedger(amount, note), null, true, true) }
    catch (err) { setError(err instanceof Error ? err.message : '初始化失败。'); return false }
  }, [persist])
  const exportBackup = useCallback(() => {
    if (committed.current.mode !== 'personal' || !committed.current.initialized || committed.current.damaged) throw new Error('请先建立可读取的个人储备。')
    return makeBackup(committed.current.ledger)
  }, [])
  const previewImport = useCallback((text: string) => {
    cancelImport()
    if (committed.current.mode !== 'personal' || pending.current) { setError('请在个人储备中、保存完成后导入备份。'); return null }
    finish()
    try {
      const data = parseBackup(text)
      const raw = localStorage.getItem(PERSONAL_KEY)
      if (!committed.current.damaged && (readPersonal(localStorage)?.revision ?? null) !== committed.current.revision) {
        replaceSaved(readSaved('personal'))
        throw new Error('另一标签页更新了账本，已读取最新余额，请重新选择备份。')
      }
      preview.current = { data, revision: committed.current.revision, raw }
      setImportPreview(data); setError('')
      return data
    } catch (err) { setError(err instanceof Error ? err.message : '备份无法读取。'); return null }
  }, [replaceSaved, finish, cancelImport])
  const confirmImport = useCallback(async () => {
    const staged = preview.current
    if (!staged || committed.current.mode !== 'personal') return false
    if (staged.revision !== committed.current.revision) { cancelImport(); setError('账本已变化，请重新预览备份后确认。'); return false }
    return persist(staged.data.ledger, null, true, true, { raw: staged.raw })
  }, [persist, cancelImport])
  const reset = useCallback(() => {
    if (committed.current.mode !== 'demo') { setError('个人储备不会被体验重置清除。'); return }
    if (pending.current || !window.confirm('将体验余额恢复为 ¥800.00，并清除体验记录？你的个人储备不受影响。')) return
    try {
      const ledger = freshLedger()
      sessionStorage.setItem(DEMO_KEY, JSON.stringify(ledger))
      replaceSaved({ mode: 'demo', ledger, revision: null, initialized: true, error: '', damaged: false })
    } catch { setError('体验重置保存失败，现有余额保持不变。') }
  }, [replaceSaved])
  return { ledger: saved.ledger, amount: balance(saved.ledger), visualAmount: presentation.visualAmount, motionPending: presentation.transactions.length > 0, transactions: presentation.transactions, resetRevision: presentation.generation, mode: saved.mode, initialized: saved.initialized, damaged: saved.damaged, transaction: presentation.transaction, error, setError, busy, submit, finish, reset, switchMode, initialize, undo, exportBackup, previewImport, confirmImport, importPreview, cancelImport }
}
