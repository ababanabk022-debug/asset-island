import { useState } from 'react'
import type { useReserveDemo } from './useReserveDemo'
import { money } from '../domain/reserve'
import { MAX_BACKUP_BYTES } from '../storage/ledgerStore'
export function LedgerSheet({ demo, reduced }: { demo: ReturnType<typeof useReserveDemo>; reduced: boolean }) {
  const [notice, setNotice] = useState('')
  const [limit, setLimit] = useState(30)
  const exportFile = () => {
    try {
      const url = URL.createObjectURL(new Blob([demo.exportBackup()], { type: 'application/json' }))
      const a = document.createElement('a'); a.href = url; a.download = `资产岛-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice('备份已导出。请妥善保存这份文件。')
    } catch (err) { demo.setError((err as Error).message) }
  }
  const entries = demo.ledger.entries
  return <div className="ledger-sheet">
    <p className="sheet-intro">{demo.mode === 'demo' ? '体验岛 · 只保存当前标签页的体验记录' : '我的账本 · 只保存在这台设备的浏览器'}。个人账本与体验岛互不影响。</p>
    <div className="ledger-summary"><span>当前储备<strong>¥{money(demo.amount)}</strong></span><span>起始余额<strong>¥{money(demo.ledger.initial)}</strong></span></div>
    <div className="backup-actions">{demo.mode === 'personal' ? <><button disabled={!demo.initialized || demo.damaged} onClick={exportFile}>导出备份</button><label className="file-button">导入备份<input type="file" accept=".json,application/json" aria-label="导入备份" onChange={async e => { const file=e.target.files?.[0]; if (!file) return; if (file.size>MAX_BACKUP_BYTES) { demo.setError('备份文件过大，请选择小于 8 MB 的文件。'); return }; try { demo.previewImport(await file.text()) } catch { demo.setError('无法读取文件，请重新选择备份。') }; e.target.value='' }} /></label></> : <button className="muted-button" onClick={demo.reset}>重置体验岛</button>}</div>
    {demo.importPreview && <div className="import-preview"><h3>检查这份备份</h3><p>导入后将替换个人账本。请先导出当前记录。</p><p>余额 ¥{money(demo.importPreview.amount)} · {demo.importPreview.entries} 笔记录</p><div><button onClick={demo.cancelImport}>取消</button><button className="primary-button" disabled={demo.busy} onClick={async () => { if (await demo.confirmImport()) setNotice('备份已恢复，岛上的储备已同步。') }}>确认替换个人账本</button></div></div>}
    {notice && <p role="status">{notice}</p>}{demo.error && <p className="transaction-error" role="alert">{demo.error}</p>}
    <div className="history-title"><h3>岛屿手记</h3><span>{entries.length} 笔</span></div>
    {entries.length ? <ol className="entry-list">{entries.slice(-limit).reverse().map(entry => {
      const reversed = entries.some(item => item.reverses === entry.id)
      return <li key={entry.id} className={reversed ? 'reversed' : ''}><span className={'entry-direction '+entry.type}>{entry.type === 'income' ? '↗' : '↙'}</span><div><strong>{entry.reverses ? '撤销更正' : entry.note || (entry.type === 'income' ? '收入到岸' : '为生活花费')}</strong><small>{new Date(entry.at).toLocaleString('zh-CN', { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' })}{reversed ? ' · 已撤销' : ''}</small></div><span className="entry-value">{entry.type === 'income' ? '+' : '−'}¥{money(entry.amount)}{!entry.reverses && !reversed && <button disabled={demo.busy} onClick={() => void demo.undo(entry.id, reduced)}>撤销</button>}</span></li>
    })}</ol> : <div className="empty-history"><p>这里会留下每一笔的来去。</p><span>从记下一笔收入或支出开始。</span></div>}
    {entries.length > limit && <button className="load-more" onClick={() => setLimit(n=>n+30)}>再看 30 笔</button>}
    {demo.mode === 'personal' && <p className="sheet-footnote">清理浏览器数据前，请导出备份。个人储备支持 ¥0—1,000,000，不含负债、云同步和银行连接。</p>}
  </div>
}
