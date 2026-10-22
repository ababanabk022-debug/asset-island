import { useState, type FormEvent } from 'react'
import { denomination, GOLD, STONE, STONES_PER_GOLD, money, parseAmount, type Entry } from '../domain/reserve'
import type { useReserveDemo } from './useReserveDemo'

type Demo = ReturnType<typeof useReserveDemo>
export function ReservePanel({ demo, available, reduced, revealScene }: { demo: Demo; available: boolean; reduced: boolean; revealScene: () => void }) {
  const [input, setInput] = useState('200')
  const [note, setNote] = useState('')
  const [initial, setInitial] = useState('0')
  const reserve = denomination(demo.amount)
  const busy = demo.busy
  const blocked = busy || demo.damaged || !demo.initialized
  const toMerge = GOLD - demo.amount % GOLD
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const button = (event.nativeEvent as SubmitEvent).submitter
    const type: Entry['type'] = button instanceof HTMLButtonElement && button.value === 'expense' ? 'expense' : 'income'
    const submittedNote = note
    try { if (await demo.submit(type, parseAmount(input), reduced || !available, submittedNote)) { setNote(current => current === submittedNote ? '' : current); if (!reduced) revealScene() } }
    catch (err) { demo.setError((err as Error).message) }
  }
  const quick = async (kind: Entry['type'], amount: number) => { if (await demo.submit(kind, amount, reduced || !available) && !reduced) revealScene() }
  const latest = demo.ledger.entries.at(-1)
  return <>
    <div className="balance-heading"><span className="eyebrow">YOUR LITTLE FORTUNE</span><span className="mode-label">{demo.mode === 'demo' ? '体验岛' : '我的账本'}</span></div>
    <div className="reserve-balance"><span>岛上的储备</span><strong aria-label="储备余额" data-testid="balance"><small>¥</small>{money(demo.amount)}</strong></div>
    <div className="reserve-counts" aria-label="已提交储备" data-testid="reserve-counts"><span><i className="gold-chip" />金矿 <b>{reserve.gold.toLocaleString()}</b></span><span><i className="sand-chip" />砂岩 <b>{reserve.stones}</b></span>{reserve.remainder > 0 && <span className="remainder">余量 ¥{money(reserve.remainder)}</span>}</div>
    {demo.damaged ? <p className="sheet-intro">记录暂时无法读取。请打开「岛屿手记」，{demo.mode === 'personal' ? '导入有效备份恢复个人账本。原始数据会保留到你确认替换。' : '重置体验岛后继续。'}</p> : !demo.initialized ? <form className="setup-form" onSubmit={async event => { event.preventDefault(); try { await demo.initialize(/^0(?:\.0{1,2})?$/.test(initial) ? 0 : parseAmount(initial)) } catch (err) { demo.setError((err as Error).message) } }}>
      <h2>从你的第一块石头开始。</h2><p>填写起始储备。体验岛的记录不会带入这里。</p><label htmlFor="initial-amount">起始余额（元）</label><input id="initial-amount" inputMode="decimal" value={initial} onChange={e => setInitial(e.target.value)} maxLength={10} /><button className="primary-button" disabled={demo.busy}>建立我的小岛</button>
    </form> : <>
      <form className="transaction-form" onSubmit={submit}>
        <label htmlFor="transaction-amount">这一笔，多少钱？</label><div className="amount-input"><span>¥</span><input id="transaction-amount" aria-label="交易金额" inputMode="decimal" autoComplete="off" value={input} maxLength={10} onChange={event => setInput(event.target.value)} disabled={busy} /></div>
        <input className="note-input" aria-label="记账备注" placeholder="留一句话，记住这一笔（可选）" value={note} onChange={e => setNote(e.target.value)} maxLength={80} disabled={busy} />
        <div className="transaction-actions">
          <button className="primary-button transaction-submit income" type="submit" name="direction" value="income" data-testid="transaction-income" disabled={blocked}><span aria-hidden="true">＋</span>记入进账</button>
          <button className="primary-button transaction-submit expense" type="submit" name="direction" value="expense" data-testid="transaction-expense" disabled={blocked}><span aria-hidden="true">−</span>记入出账</button>
        </div>
      </form>
      <div className={'motion-status ' + (demo.transaction ? 'running' : '')} data-testid="motion-status" aria-live="polite"><span className="status-dot" /><span key={busy ? 'saving' : latest?.id ?? 'ready'} className={latest && !busy ? 'saved-receipt' : ''}>{busy ? '正在保存' : latest ? `已保存 ${latest.type === 'income' ? '+' : '−'}¥${money(latest.amount)} · 可继续记账` : '每一笔来去，即刻记下'}</span>{demo.transaction && <button onClick={() => demo.finish()}>跳过动画</button>}</div>
      <div className="merge-meter"><div><span>下一块金矿</span><span>还差 ¥{money(toMerge)}</span></div><div className="meter-track">{Array.from({length:10}, (_, i) => <i key={i} className={demo.amount % GOLD / GOLD * 10 >= i + 1 ? 'filled' : ''} />)}</div><p>{STONES_PER_GOLD} 块砂岩，聚成 1 块金矿。每块砂岩 ¥{(STONE / 100).toLocaleString('zh-CN')}，金矿 ¥{(GOLD / 100).toLocaleString('zh-CN')}。</p></div>
      {demo.mode === 'demo' && <div className="quick-demo"><span>先感受一下</span><button disabled={blocked} onClick={() => quick('income', toMerge)}>看进账合成 ↗</button><button disabled={blocked || !reserve.gold} onClick={() => quick('expense', demo.amount % GOLD + 25_000)}>看出账拆分 ↙</button></div>}
    </>}
    {demo.error && <p className="transaction-error" role="alert">{demo.error}</p>}
  </>
}
