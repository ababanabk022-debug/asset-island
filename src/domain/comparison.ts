import { GOLD, STONE } from './reserve.ts'

// Historical source snapshot, never presented as a live quote.
export const MUSK_SNAPSHOT = {
  valuedAt: '2026-03-01', publishedAt: '2026-03-10', usd: 839_000_000_000,
  usdCny: 6.9228, fxAt: '2026-02-27', amount: 580_822_920_000_000,
  source: 'https://www.forbes.com.au/news/billionaires/the-forbes-billionaires-list-top-200/',
  fxSource: 'https://finance.sina.com.cn/jjxw/2026-02-27/doc-inhpfhts3841495.shtml',
} as const
export const COMPARISON_EXAMPLES = [
  { id: '10k', label: '一万元', amount: 1_000_000, caption: '数量示例 · 100 块砂岩' },
  { id: '100k', label: '十万元', amount: 10_000_000, caption: '数量示例 · 5 块金矿' },
  { id: '1m', label: '一百万元', amount: 100_000_000, caption: '数量示例 · 50 块金矿' },
  { id: 'musk', label: '马斯克', amount: MUSK_SNAPSHOT.amount, caption: '2026-03-01 净资产估值快照' },
] as const
export type ComparisonId = typeof COMPARISON_EXAMPLES[number]['id']
export type ComparisonVector = [number, number, number]
export const COMPARISON_GOLD_DIMENSIONS: ComparisonVector = [2.1666975021362305, 1.6140283271088265, 1.7441970109939575]
export const COMPARISON_GOLD_VOLUME = 3.3714909567698728
export const COMPARISON_RUNTIME_SCALE = .45
export const CELL: ComparisonVector = [COMPARISON_GOLD_DIMENSIONS[0] * .45 + .025, COMPARISON_GOLD_DIMENSIONS[1] * .45, COMPARISON_GOLD_DIMENSIONS[2] * .45 + .025]
export const COMPARISON_GROUND = .555
export const COMPARISON_WATER_RADIUS = 7.4
export const INSTANCE_LIMIT = 10_000
export interface PileLayer { index: number; side: number; count: number; rows: number; tail: number }
function validAmount(amount: number) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('比较金额必须是非负整数分。')
}
export function comparisonBreakdown(amount: number) {
  validAmount(amount)
  if (amount % STONE) throw new Error('对比示例必须是完整砂岩金额。')
  const gold = Math.floor(amount / GOLD), sand = amount % GOLD / STONE
  return { gold, sand, total: gold + sand }
}
/** Whole gold count only; a remainder is represented by real sandstone. */
export const comparisonCount = (amount: number) => comparisonBreakdown(amount).gold
export function comparisonPieceLabel(amount: number) {
  const { gold, sand } = comparisonBreakdown(amount)
  return [gold ? `${gold.toLocaleString('zh-CN')} 块金矿` : '', sand ? `${sand.toLocaleString('zh-CN')} 块砂岩` : ''].filter(Boolean).join(' · ') || '0 块'
}
const capacity = (side: number) => side * (side + 1) * (2 * side + 1) / 6
/** Fill supported bottom layers first; no arbitrary cap or hidden value loss. */
export function comparisonLayers(amount: number): PileLayer[] {
  validAmount(amount)
  if (amount % GOLD) throw new Error('金矿堆层只能表示完整金矿金额；砂岩使用单独的静态实例。')
  let remaining = comparisonCount(amount)
  if (!remaining) return []
  let base = Math.max(1, Math.ceil(Math.cbrt(3 * remaining)))
  while (capacity(base - 1) >= remaining) base--
  while (capacity(base) < remaining) base++
  const layers: PileLayer[] = []
  for (let side = base, index = 0; remaining > 0; side--, index++) {
    const count = Math.min(remaining, side * side)
    layers.push({ index, side, count, rows: Math.ceil(count / side), tail: count % side })
    remaining -= count
  }
  return layers
}
/** Every returned position is one whole, identical gold model in WORLD units. */
export function comparisonCells(amount: number): ComparisonVector[] {
  if (comparisonCount(amount) > INSTANCE_LIMIT) throw new Error('极大量使用分层表面，不分配无限实例。')
  const cells: ComparisonVector[] = []
  for (const layer of comparisonLayers(amount)) {
    for (let row = 0; row < layer.rows; row++) {
      const columns = Math.min(layer.side, layer.count - row * layer.side)
      for (let col = 0; col < columns; col++) cells.push([
        (col - (columns - 1) / 2) * CELL[0], layer.index * CELL[1], (row - (layer.rows - 1) / 2) * CELL[2],
      ])
    }
  }
  return cells
}
export function comparisonVolume(amount: number) {
  // Kept as the gold-only measured mesh volume; sandstone is counted
  // independently and never misrepresented as a fractional gold nugget.
  return comparisonCount(amount) * COMPARISON_GOLD_VOLUME * COMPARISON_RUNTIME_SCALE ** 3
}
export function comparisonLayout(amount: number) {
  const pieces = comparisonBreakdown(amount), layers = comparisonLayers(pieces.gold * GOLD), count = pieces.total
  const far = pieces.gold > INSTANCE_LIMIT
  const base = layers[0]
  const width = base ? Math.min(base.side, base.count) * CELL[0] : 0
  const depth = base ? base.rows * CELL[2] : 0
  const height = layers.length * CELL[1]
  // The first three examples share the EXACT same land footprint. A separate
  // continental site accommodates the historical billionaire snapshot; no
  // existing island, tree or gold model is enlarged to make it fit.
  const radiusX = far ? Math.max(COMPARISON_WATER_RADIUS, width * .95 + 3) * 1.2 : COMPARISON_WATER_RADIUS
  const radiusZ = far ? Math.max(COMPARISON_WATER_RADIUS, depth * .95 + 3) * 1.2 : COMPARISON_WATER_RADIUS
  const position: ComparisonVector = [-(11 + radiusX), COMPARISON_GROUND, 0]
  const boundsMin: ComparisonVector = [position[0] - radiusX, -1.6, -radiusZ]
  const boundsMax: ComparisonVector = [position[0] + radiusX, far ? COMPARISON_GROUND + Math.max(height, 6.2) : 5.2, radiusZ]
  return { position, width, depth, height, unitScale: COMPARISON_RUNTIME_SCALE,
    radiusX, radiusZ, boundsMin, boundsMax, count, goldCount: pieces.gold, sandCount: pieces.sand,
    layers, volume: comparisonVolume(amount), far }
}

export function comparisonRatio(exampleAmount: number, ownAmount: number): string {
  validAmount(exampleAmount); validAmount(ownAmount)
  if (!ownAmount) return '你的余额为 0，暂不计算倍数'
  const ratio = exampleAmount / ownAmount
  if (ratio > 0 && ratio < .01) return '对比金额小于你的储备的 0.01 倍'
  const formatted = ratio.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  const prefix = Number.isInteger(ratio) ? '' : '约 '
  return `对比金额是你的储备的 ${prefix}${formatted} 倍`
}
