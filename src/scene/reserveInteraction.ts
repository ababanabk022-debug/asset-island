import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'

/** Shared only by the canvas controls and the physical reserve. */
export interface ReserveInteraction {
  dragging: boolean
  orbit: OrbitControls | null
  nudge: ((velocity: [number, number]) => void) | null
  release: (() => void) | null
}
export const createReserveInteraction = (): ReserveInteraction => ({ dragging: false, orbit: null, nudge: null, release: null })
