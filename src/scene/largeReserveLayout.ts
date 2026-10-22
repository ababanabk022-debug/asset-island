import { comparisonCells, CELL } from '../domain/comparison.ts'
import { GOLD, STONE } from '../domain/reserve.ts'

export type ReserveCell = { position: [number, number, number]; scale: number; value: number }
export function largeReserveCells(amount: number): { gold: ReserveCell[]; sand: ReserveCell[] } {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100_000_000) throw new RangeError('Personal reserve supports 0 to 1,000,000 yuan')
  const whole = Math.floor(amount / GOLD) * GOLD
  const gold = comparisonCells(whole).map(position => ({ position: [position[0], position[1] + .35, position[2]] as ReserveCell['position'], scale: .45, value: GOLD }))
  const sand: ReserveCell[] = []
  const depth = gold.reduce((max, cell) => Math.max(max, cell.position[2]), 0)
  for (let remaining = amount - whole, i = 0; remaining > 0; remaining -= STONE, i++) {
    sand.push({ position: [-.7 + i % 5 * .4, .35, Math.min(10.4, depth + CELL[2] * .7) + Math.floor(i / 5) * .42], scale: .45 * Math.cbrt(Math.min(STONE, remaining) / STONE), value: Math.min(STONE, remaining) })
  }
  return { gold, sand }
}
