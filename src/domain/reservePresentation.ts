import type { Transaction } from './reserve.ts'

export const PRESENTATION_EVENT_LIMIT = 128

/** Saved entries flow into one live world without waiting for earlier motion. */
export type ReservePresentation = {
  visualAmount: number
  transaction: Transaction | null
  transactions: Transaction[]
  generation: number
}

export function createPresentation(amount: number): ReservePresentation {
  return { visualAmount: amount, transaction: null, transactions: [], generation: 0 }
}

/** Invalidate pending scene events and any write that began before this snap. */
export function snapPresentation(state: ReservePresentation, amount: number): ReservePresentation {
  return { visualAmount: amount, transaction: null, transactions: [], generation: state.generation + 1 }
}

/** Call only after persistence succeeds. Failed writes must not reach this function. */
export function commitPresentation(
  state: ReservePresentation,
  amount: number,
  motion: Transaction | null,
  animate: boolean,
  writeGeneration: number,
): ReservePresentation {
  if (!animate || !motion || writeGeneration !== state.generation) return snapPresentation(state, amount)
  // An interrupted/overloaded renderer can rebuild from the committed target.
  // The ledger retains every entry even if its presentation journal is reset.
  if (state.transactions.length >= PRESENTATION_EVENT_LIMIT || motion.before !== state.visualAmount || motion.after !== amount) {
    return snapPresentation(state, amount)
  }
  return { ...state, visualAmount: amount, transaction: motion, transactions: [...state.transactions, motion] }
}

/** Scene acknowledgements retire an ingested prefix, never newer entries. */
export function completePresentation(state: ReservePresentation, id: string): ReservePresentation {
  const index = state.transactions.findIndex(transaction => transaction.id === id)
  if (index < 0) return state
  const transactions = state.transactions.slice(index + 1)
  return { ...state, transaction: transactions.at(-1) ?? null, transactions }
}
