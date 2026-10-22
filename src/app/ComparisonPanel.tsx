import { COMPARISON_EXAMPLES, MUSK_SNAPSHOT, comparisonBreakdown, comparisonPieceLabel, comparisonRatio, type ComparisonId } from '../domain/comparison'
import { GOLD, STONES_PER_GOLD, money } from '../domain/reserve'

interface ComparisonPanelProps {
  amount: number
  selected: ComparisonId
  onSelect: (id: ComparisonId) => void
  onReturn: () => void
  transitioning: boolean
  returning: boolean
  onSkip: () => void
}

export function ComparisonPanel({ amount, selected, onSelect, onReturn, transitioning, returning, onSkip }: ComparisonPanelProps) {
  const example = COMPARISON_EXAMPLES.find(item => item.id === selected) ?? COMPARISON_EXAMPLES[0]
  const historical = selected === 'musk'
  const pieces = comparisonBreakdown(example.amount)
  return <section className="comparison-panel" data-testid="comparison-panel" aria-label="财富量级比较">
    <div className="panel-heading">
      <p className="eyebrow">A CHANGE OF PERSPECTIVE</p>
      <h2 tabIndex={-1}>把积累，放远一点看。</h2>
      <p>金矿一样大，多的是数量。</p>
    </div>

    <div className="comparison-total">
      <span>眼前的资产山 <i>{historical ? '历史估值' : '数量示例'}</i></span>
      <strong data-testid="comparison-amount"><small>¥</small>{historical ? '约 5.81 万亿' : money(example.amount).replace(/\.00$/, '')}</strong>
      <p className="comparison-piece-count" data-testid="comparison-count"><b>{(pieces.gold || pieces.sand).toLocaleString('zh-CN')}</b> 块{pieces.gold ? '金矿' : '砂岩'}</p>
      <p className="comparison-ratio" data-testid="comparison-ratio">{comparisonRatio(example.amount, amount)}</p>
    </div>

    <div className="comparison-own"><span className="status-dot" /><span>我的小岛</span><strong>¥{money(amount)}</strong></div>

    <div className="comparison-options" role="group" aria-label="选择比较量级">
      {COMPARISON_EXAMPLES.map((item, index) => <button
        key={item.id}
        type="button"
        className={'comparison-option' + (selected === item.id ? ' selected' : '')}
        data-testid={`comparison-example-${item.id}`}
        aria-pressed={selected === item.id}
        disabled={returning}
        onClick={() => onSelect(item.id)}
      >
        <span className="comparison-option-number" aria-hidden="true">0{index + 1}</span>
        <span className="comparison-option-copy"><strong>{item.label}</strong><small>{item.id === 'musk' ? '约 ¥5.81 万亿 · 历史估值' : `${comparisonPieceLabel(item.amount)} · ¥${money(item.amount).replace(/\.00$/, '')}`}</small></span>
        <span className="comparison-option-mark" aria-hidden="true">{selected === item.id ? '✓' : '↗'}</span>
      </button>)}
    </div>

    <p className="comparison-scale-note">每块砂岩代表 ¥100，{STONES_PER_GOLD} 块合成一块 ¥{money(GOLD).replace(/\.00$/, '')} 金矿。石块大小与我的小岛一致，房屋和树木不计入资产。</p>
    {historical ? <div className="comparison-source-note">
      <p>这是约 2.9 亿块金矿的全景；单块已小到看不清。广阔岛屿承载全部储备，房屋、树木和你的小岛保留原尺寸。</p>
      <details><summary>估值日期与来源</summary>
        <p><a href={MUSK_SNAPSHOT.source} target="_blank" rel="noreferrer">Forbes 2026 榜单</a>：截至 2026-03-01，估计净资产 8,390 亿美元，非今日实时估值。</p>
        <p><a href={MUSK_SNAPSHOT.fxSource} target="_blank" rel="noreferrer">2026-02-27 汇率中间价公告</a>：1 美元 = 6.9228 元。按此快照换算约 ¥{money(example.amount).replace(/\.00$/, '')}。</p>
        <p>净资产包含股权等估值，并非可消费的现金；这里与个人储备比较仅用于感受金额量级。金矿数量是按上述估值换算，不表示实际持有黄金。</p>
      </details>
    </div> : <p className="comparison-fiction-note">三档金额使用与你相同的小岛，以石块数量呈现差别，不代表普通人的平均资产或任何人的真实财富。</p>}

    <div className="comparison-actions">
      <button type="button" className="comparison-return" onClick={onReturn} disabled={returning}><span aria-hidden="true">↶</span>回到我的小岛</button>
      {transitioning && <div className="comparison-transition"><span>{returning ? '回到你刚才的视角…' : '正在拉远视野…'}</span><button type="button" onClick={onSkip}>直接到达</button></div>}
    </div>
  </section>
}
