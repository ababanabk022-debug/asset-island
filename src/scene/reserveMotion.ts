import { GOLD, STONE, type Transaction } from '../domain/reserve.ts'

export type Vec3 = [number, number, number]
export type Piece = { kind: 'sand' | 'gold'; value: number; position: Vec3; factor: number; rotation: number; orientation?: [number, number, number, number]; centered?: boolean; crack?: number }
export const SMALL_SCALE = .45
export const ground = .61
export const splash: Vec3 = [5.35, .1, 4.5]
export const goldPosition = (i: number): Vec3 => [.05 + [0, -1.08, 1.08, -2.16][i % 4], ground + Math.floor(i / 12) * .78, .65 + Math.floor(i / 4) % 3 * .94]
export const sandPosition = (i: number): Vec3 => [-.85 - i % 4 * .42 + Math.sin(i * 7) * .065, ground + Math.floor(i / 16) * .36, 1.35 + Math.floor(i / 4) % 4 * .43 + Math.cos(i * 5) * .055]
function pieces(amount: number, kind: Piece['kind'], offset = 0): Piece[] {
  const unit = kind === 'gold' ? GOLD : STONE
  const result: Piece[] = []
  for (let rest = amount, i = offset; rest > 0; rest -= unit, i++) {
    result.push({ kind, value: Math.min(rest, unit), position: kind === 'gold' ? goldPosition(i) : sandPosition(i), factor: 1, rotation: kind === 'gold' ? (i % 2 ? .05 : -.04) : Math.sin(i * 13) * .48 })
  }
  return result
}
export function restingPieces(amount: number): Piece[] {
  return [...pieces(Math.floor(amount / GOLD) * GOLD, 'gold'), ...loosePieces(amount)]
}
function loosePieces(amount: number) {
  return pieces(amount % GOLD, 'sand').map((piece, i) => amount < 2 * GOLD ? piece : { ...piece, position: sideSandPosition(i) })
}
export const sideSandPosition = (i: number): Vec3 => [2.2 + i % 2 * .43, ground + Math.floor(i / 10) * .37, .55 + Math.floor(i / 2) % 5 * .43]
interface Fragment { source: Piece; target: Piece | null; value: number }
function allocate(pool: Piece[], target: Piece[], spent = 0): Fragment[] {
  const destinations: { piece: Piece | null; remaining: number }[] = [
    ...(spent ? [{ piece: null, remaining: spent }] : []), ...target.map(piece => ({ piece, remaining: piece.value })),
  ]
  let index = 0
  const result: Fragment[] = []
  for (const source of pool) {
    let left = source.value
    while (left > 0) {
      const destination = destinations[index]
      if (!destination) throw new Error('Reserve animation lost value')
      const value = Math.min(left, destination.remaining)
      result.push({ source, target: destination.piece, value })
      left -= value; destination.remaining -= value
      if (!destination.remaining) index++
    }
  }
  return result
}
export function makeMotion(transaction: Transaction) {
  const { before, after, type, amount } = transaction
  const beforeGold = Math.floor(before / GOLD), afterGold = Math.floor(after / GOLD)
  const fixedGold = Math.min(beforeGold, afterGold)
  const fixed = pieces(fixedGold * GOLD, 'gold')
  const looseBefore = loosePieces(before).sort((a, b) => a.value - b.value)
  const looseAfter = loosePieces(after)
  const addedGold = pieces((afterGold - fixedGold) * GOLD, 'gold', fixedGold)
  // Large transfers retain the same visible volume without exploding hundreds
  // of small bodies: move whole gold denominations, split only the change.
  const wholeSpent = type === 'expense' ? Math.floor(Math.max(0, amount - before % GOLD) / GOLD) : 0
  const brokenGold = pieces((beforeGold - fixedGold - wholeSpent) * GOLD, 'gold', fixedGold)
  const spendingGold = pieces(wholeSpent * GOLD, 'gold', fixedGold + brokenGold.length)
  const bulkIncome = type === 'income' && amount > GOLD
  const incoming = type === 'income' ? (bulkIncome
    ? [...pieces(Math.floor(amount / GOLD) * GOLD, 'gold', fixedGold), ...pieces(amount % GOLD, 'sand', looseBefore.length)]
    : pieces(amount, 'sand', looseBefore.length)) : []
  if (after >= 2 * GOLD) incoming.filter(p => p.kind === 'sand').forEach((p, i) => { p.position = sideSandPosition(i + looseBefore.length) })
  const released = type === 'expense' ? pieces(brokenGold.length * GOLD, 'sand', looseBefore.length) : []
  const pool = [...looseBefore, ...spendingGold, ...incoming, ...released]
  const targets = [...addedGold, ...looseAfter.sort((a, b) => a.value - b.value)]
  const fragments = allocate(pool, targets, type === 'expense' ? amount : 0)
  return { transaction, fixed, looseBefore, incoming, released, brokenGold, spendingGold, addedGold, pool, targets, fragments, bulkIncome }
}
export type MotionPlan = ReturnType<typeof makeMotion>
