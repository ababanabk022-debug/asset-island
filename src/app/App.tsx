import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { type Quality, type View } from '../config/art'
import { useReserveDemo } from './useReserveDemo'
import { ReservePanel } from './ReservePanel'
import { Dialog } from './Dialog'
import { LedgerSheet } from './LedgerSheet'
import { ComparisonPanel } from './ComparisonPanel'
import { COMPARISON_EXAMPLES, type ComparisonId } from '../domain/comparison'
import type { CameraStatus } from '../scene/CameraRig'
import '../comparison.css'
import { denomination, GOLD, STONE, STONES_PER_GOLD } from '../domain/reserve'
import type { SceneStats } from '../scene/IslandScene'
import { soundEngine } from '../audio/soundEngine'

const IslandScene = lazy(() => import('../scene/IslandScene').then(module => ({ default: module.IslandScene })))

function hasWebGL() {
  try {
    const context = document.createElement('canvas').getContext('webgl2')
    if (!context) return false
    context.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch { return false }
}

function Glyph({ name }: { name: 'island' | 'rotate' | 'home' | 'arrow' | 'sun' | 'check' | 'sound' }) {
  const paths = {
    island: <><path d="M3 19h18M6 15l6-10 6 10H6Z" /><path d="M12 5v10" /></>,
    rotate: <><path d="M20 10a8 8 0 1 0-1.5 7M20 4v6h-6" /></>,
    home: <><path d="m4 10 8-7 8 7v10H4V10Z" /><path d="M9 20v-7h6v7" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
    sound: <><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

class SceneBoundary extends Component<{ children: ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { this.props.onFailure() }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

export function App() {
  const demo = useReserveDemo()
  const [comparing, setComparing] = useState(false)
  const [selected, setSelected] = useState<ComparisonId>('10k')
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('island')
  const [skipRevision, setSkipRevision] = useState(0)
  const [sheet, setSheet] = useState<'history' | 'settings' | null>(null)
  const comparisonVisible = comparing || cameraStatus !== 'island'
  const compareEntry = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const previousComparison = useRef(false)
  const example = COMPARISON_EXAMPLES.find(item => item.id === selected)!
  const [phase, setPhase] = useState('储备已归位')
  const [quality, setQuality] = useState<Quality>(() => matchMedia('(max-width:760px)').matches ? 'low' : 'high')
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [sound, setSound] = useState(() => { try { return localStorage.getItem('time-island:sound') === 'on' } catch { return false } })
  const toggleSound = (enabled: boolean) => {
    setSound(enabled); soundEngine.setEnabled(enabled)
    if (enabled) void soundEngine.unlock()
    try { localStorage.setItem('time-island:sound', enabled ? 'on' : 'off') } catch { /* Preference is optional; bookkeeping has its own storage errors. */ }
  }
  const [rotating, setRotating] = useState(false)
  const [ready, setReady] = useState(false)
  const [lost, setLost] = useState(false)
  const [failed, setFailed] = useState(() => !hasWebGL())
  const [active, setActive] = useState(!document.hidden)
  const [stats, setStats] = useState<SceneStats | null>(null)
  const [view, setView] = useState<{ name: View; revision: number }>({ name: 'home', revision: 0 })
  const onReady = useCallback(() => setReady(true), [])
  const onContextLost = useCallback(() => setLost(true), [])
  const onFailure = useCallback(() => setFailed(true), [])
  const changeView = (name: View) => { if (comparisonVisible) { setComparing(false); return }; setRotating(false); setView(v => ({ name, revision: v.revision + 1 })) }
  const enterComparison = () => { demo.finish(); setRotating(false); setComparing(true) }
  const selectComparison = (id: ComparisonId) => {
    if (id === selected) return
    setCameraStatus('outbound'); setSelected(id)
  }
  useEffect(() => {
    if (comparisonVisible !== previousComparison.current) {
      const target = comparisonVisible ? panel.current?.querySelector<HTMLElement>('.comparison-panel h2') : compareEntry.current
      target?.focus({ preventScroll: true })
      previousComparison.current = comparisonVisible
    }
  }, [comparisonVisible])
  useEffect(() => {
    const update = () => setActive(!document.hidden)
    document.addEventListener('visibilitychange', update)
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const motionChanged = () => setReduced(media.matches)
    media.addEventListener('change', motionChanged)
    return () => { document.removeEventListener('visibilitychange', update); media.removeEventListener('change', motionChanged) }
  }, [])
  useEffect(() => { if (!active || reduced || lost || failed) demo.finish() }, [active, reduced, lost, failed, demo.finish])
  useEffect(() => {
    soundEngine.setEnabled(sound)
    const unlock = () => { if (sound) void soundEngine.unlock() }
    window.addEventListener('pointerdown', unlock, { capture: true })
    window.addEventListener('keydown', unlock, { capture: true })
    return () => { window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); soundEngine.stop() }
  }, [sound])
  useEffect(() => { soundEngine.setActive(active && !failed && !lost); soundEngine.setReducedMotion(reduced) }, [active, reduced, failed, lost])
  useEffect(() => { if (!demo.transaction) soundEngine.stop() }, [demo.transaction])
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const inspect = () => soundEngine.inspect()
    const host = window as typeof window & { __islandSoundInspect?: typeof inspect }
    host.__islandSoundInspect = inspect
    return () => { delete host.__islandSoundInspect }
  }, [])
  const reserve = denomination(demo.amount)
  return <main className={'app-shell' + (comparisonVisible ? ' world-mode' : '')}>
    <header className="topbar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); changeView('home') }} aria-label="资产岛，返回初始视角"><span className="brand-mark"><Glyph name="island" /></span><span>资产岛<span className="brand-en">SMALL FORTUNES</span></span></a>
      <nav className="main-nav" aria-label="主要导航"><button className={!comparisonVisible ? 'current' : ''} onClick={() => setComparing(false)}>我的小岛</button><button className={comparisonVisible ? 'current' : ''} disabled={!ready || failed || lost} onClick={enterComparison}>财富尺度</button></nav>
      <div className="header-actions"><button className="sound-toggle" onClick={() => toggleSound(!sound)} aria-label={sound ? '关闭声音' : '开启声音'} aria-pressed={sound} title={sound ? '声音已开启' : '开启小岛音效'}><Glyph name="sound" /><span>{sound ? '声音开' : '声音关'}</span></button><button onClick={() => setSheet('history')}>岛屿手记 <span className="entry-badge">{demo.ledger.entries.length}</span></button><button onClick={() => setSheet('settings')} aria-label="打开设置"><Glyph name="sun" /></button></div>
    </header>
    <section className={'viewport ' + (view.name === 'close' ? 'inspect ' : '') + (comparisonVisible ? 'comparing' : '')} aria-label="可旋转的资产岛三维场景">
      <div className="scene-heading"><p className="eyebrow"><span className="eyebrow-line" /> A LIFE, LITTLE BY LITTLE</p><h1>让积累，<br />有自己的形状<span>。</span></h1><p className="intro">每一笔来去，都留下生活的痕迹。</p></div>
      <div className="canvas-wrap">
        {!failed && <SceneBoundary onFailure={onFailure}><Suspense fallback={null}><IslandScene amount={demo.visualAmount} transaction={demo.transaction} transactions={demo.transactions} resetRevision={demo.resetRevision} onComplete={demo.finish} onPhase={setPhase} quality={quality} reduced={reduced} rotating={rotating}
          comparing={comparing} comparisonAmount={example.amount} comparisonVisible={comparisonVisible} comparisonArrived={comparing && cameraStatus === 'comparing'}
          skipRevision={skipRevision} onCameraStatus={setCameraStatus}
          view={view} active={active && !lost} onReady={onReady} onStats={setStats} onContextLost={onContextLost} onFailure={onFailure} /></Suspense></SceneBoundary>}
      </div>
      {!ready && !lost && !failed && <div className="loading" role="status"><span className="loading-ring" /><span>小岛正在醒来<small>准备光影与储备，让之后的变化更顺畅。</small></span></div>}
      {(failed || lost) && <div className="scene-error" role="alert"><strong>小岛暂时未能加载</strong><p>请检查浏览器图形加速后重试。你的账本仍可记账、查看和备份。</p><button onClick={() => window.location.reload()}>重新加载小岛</button></div>}
      {comparisonVisible && <div className="comparison-scene-heading"><p className="eyebrow">SAME GOLD. ANOTHER WORLD.</p><h1>换个尺度，看见差距。</h1><p>每一块都一样大，只是数量不同。</p></div>}
      <div className="scene-tag"><span className="status-dot" /><span>{comparisonVisible ? example.label + ' · ' + (selected === 'musk' ? '历史估值全景' : '相同金矿，真实数量') : demo.transaction ? phase : `${reserve.gold.toLocaleString()} 块金矿 · ${reserve.stones} 块小砂岩${reserve.remainder ? ' · 含余量' : ''}`}</span></div>
      <nav hidden={comparisonVisible} className="view-tools" aria-label="相机控制"><button className={view.name === 'home' ? 'active' : ''} onClick={() => changeView('home')} aria-label="回到初始视角"><Glyph name="home" /></button><span className="tool-separator" /><button onClick={() => changeView('front')} aria-pressed={view.name === 'front'}>正面</button><button onClick={() => changeView('back')} aria-pressed={view.name === 'back'}>背面</button><button onClick={() => changeView('close')} aria-pressed={view.name === 'close'}>近看</button><span className="tool-separator" /><button onClick={() => setRotating(v=>!v)} className={rotating && !reduced ? 'active' : ''} disabled={reduced} aria-label="自动环绕" aria-pressed={rotating && !reduced}><Glyph name="rotate" /></button></nav>
      <div className="gesture-hint">拖石头把玩 <span>·</span> 拖空白转岛 <span>·</span> 双指缩放</div>
      <div className="scene-coordinate" aria-hidden="true">01 / YOUR OWN PACE</div>
    </section>
    <aside ref={panel} className="study-panel reserve-panel" aria-label="资产操作">
      <div hidden={comparisonVisible}>
        <div className="mode-switch" role="group" aria-label="选择账本"><button aria-pressed={demo.mode==='demo'} onClick={() => void demo.switchMode('demo')} disabled={demo.busy}>先体验</button><button aria-pressed={demo.mode==='personal'} onClick={() => void demo.switchMode('personal')} disabled={demo.busy}>我的账本</button></div>
        <ReservePanel demo={demo} available={ready && !failed && !lost} reduced={reduced} revealScene={() => {}} />
        <button ref={compareEntry} className="compare-entry" disabled={!ready || failed || lost} onClick={enterComparison}><span><small>从一块金矿，到另一种世界</small>看看财富量级</span><span aria-hidden="true">↗</span></button>
      </div>
      {comparisonVisible && <ComparisonPanel amount={demo.amount} selected={selected} onSelect={selectComparison} onReturn={() => setComparing(false)} transitioning={cameraStatus==='outbound'||cameraStatus==='returning'} returning={cameraStatus==='returning'} onSkip={()=>setSkipRevision(v=>v+1)} />}
    </aside>
    <footer className="bottom-bar"><span>慢慢积累，自有风景。</span><div><span>砂岩 ¥{(STONE / 100).toLocaleString('zh-CN')}</span><span className="scale-divider">/</span><span>{STONES_PER_GOLD} 块合成金矿 ¥{(GOLD / 100).toLocaleString('zh-CN')}</span></div><span className="local-note"><span className="status-dot" /> {demo.mode==='demo' ? '体验数据 · 与个人账本分开' : '本机保存 · 记得备份'}</span></footer>
    {sheet && <Dialog title={sheet==='history' ? '每一笔，都在这里。' : '把小岛调成你喜欢的样子。'} onClose={()=>setSheet(null)}>{sheet==='history' ? <LedgerSheet demo={demo} reduced={reduced || !ready || failed || lost} /> : <div className="settings-sheet"><p className="sheet-intro">轻量画质减少阴影开销，保留每一份储备和所有交互。</p><div className="setting-line"><label htmlFor="quality">画面质量</label><select id="quality" value={quality} onChange={e=>setQuality(e.target.value as Quality)}><option value="high">精细 · 柔和阴影</option><option value="low">轻量 · 更轻快</option></select></div><label className="setting-line motion-label" htmlFor="reduced-motion"><span>减少动态效果</span><input type="checkbox" id="reduced-motion" checked={reduced} onChange={e=>{setReduced(e.target.checked);if(e.target.checked)setRotating(false)}} /><span className="switch" aria-hidden="true" /></label><p className="sheet-footnote">开启后直接显示收支结果和对比视角，余额照常保存。</p><label className="setting-line motion-label" htmlFor="island-sound"><span>小岛音效</span><input type="checkbox" id="island-sound" checked={sound} onChange={event => toggleSound(event.target.checked)} /><span className="switch" aria-hidden="true" /></label><p className="sheet-footnote">轻柔的石块碰撞、聚合与水声。页面离开前台或跳过动画时停止；减少动态效果时静音。</p><div className="about-island"><p className="eyebrow">ABOUT SMALL FORTUNES</p><h3>看见储备，也看见生活。</h3><p>用砂岩和金矿记录钱的来去。消费也有意义，不必把每一笔花费都视为损失。</p><p>个人储备支持 0—100 万元。大额收支用有限批次演出，最终数量保持准确。马斯克对比使用明确日期的历史估值，不代表现金或实时身价。</p><p>账目保存在本机浏览器，没有银行连接或云同步。清除浏览器数据前，请在岛屿手记中导出备份。</p><details><summary>运行信息</summary><p>{stats ? `${stats.fps} FPS · ${stats.calls} 次绘制` : '正在准备场景'} · 本地版 0.9</p></details></div></div>}</Dialog>}
    <span className="sr-only" data-testid="camera-status" role="status">{{island:'我的小岛',outbound:'拉远中',comparing:'对比中',returning:'返回中'}[cameraStatus]}</span>
    <span className="sr-only" role="status">{failed || lost ? '三维小岛不可用，请重试' : ready ? '三维小岛加载完成' : '三维小岛正在加载'}</span>
  </main>
}
