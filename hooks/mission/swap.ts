/**
 * Seamless updates. The app draws each Svg as an `<iframe srcdoc>` and, on every render, morphs the
 * new tree into the old one: an iframe whose attributes are all equal (its `srcdoc`, size and
 * title) is kept as it is; any other is a new iframe, inserted while the old one is removed in the
 * same step, and its area stays empty until the new document has loaded and painted: the blink.
 *
 * So: (1) a drawing whose content has not changed keeps the exact source it had, even though its
 * animation delays (computed from the time, so a reload carries a loop on where it was) would differ;
 * the app then keeps its iframe, and its animations run on undisturbed. (2) A drawing that has
 * changed loads hidden beside its predecessor for GHOST_MS, while the old one alone stays shown,
 * then the old one is removed and the new one shown: never both at once. No state here is shared
 * with the drawings: they stay pure.
 */

import type { Piece } from './draw'

/** How long a replaced drawing stays shown while its successor loads hidden: well past one load of a small document. */
export const GHOST_MS = 400

/** What one drawing shows: its source, its alt and its size. */
export type Shown = { svg: string; alt: string; width: number; height: number }

/** The animation delays a drawing derives from the time: the only part that differs between redraws. */
const DELAYS = /animation-delay:-?[\d.]+m?s;?/g
const signature = (piece: Shown): string => `${piece.width}x${piece.height}|${piece.alt}|${piece.svg.replace(DELAYS, '')}`

const last = new Map<string, Shown & { sig: string }>()
const ghosts = new Map<string, Shown & { until: number }>()

/**
 * The drawing to show for `piece` (keyed by `key`) at `now`: its earlier source when only its delays
 * differ, else the new one; and the drawing it replaced, while that is under GHOST_MS old.
 * `changed` says a ghost was laid now, so the caller draws once more after GHOST_MS to lift it.
 */
export function settle(key: string, piece: Shown, now: number): { current: Shown; ghost: Shown | null; changed: boolean } {
  const sig = signature(piece)
  const previous = last.get(key)
  let current: Shown = piece
  let changed = false
  if (previous && previous.sig === sig) {
    current = previous
  } else {
    if (previous) {
      ghosts.set(key, { svg: previous.svg, alt: previous.alt, width: previous.width, height: previous.height, until: now + GHOST_MS })
      changed = true
    }
    last.set(key, { ...piece, sig })
  }
  const ghost = ghosts.get(key)
  if (ghost && ghost.until <= now) ghosts.delete(key)
  return { current, ghost: ghost && ghost.until > now ? ghost : null, changed }
}

/** A Piece as `settle` takes it. */
export const shown = (piece: Piece): Shown => ({ svg: piece.svg, alt: piece.alt, width: piece.width, height: piece.height })
