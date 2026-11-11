import { MONO, SANS } from './tokens'

/** Text for SVG: `&`, `<`, `>` and quotes escaped. */
export const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type Face = 'sans' | 'mono'

/**
 * A text's width, estimated by character count: SVG has no measuring without script. The sans
 * average is set a little wide on purpose (system-ui at 12px averages about 0.52em), so a line
 * cut by it never runs past its box; mono is exact (0.6em a character).
 */
export const widthOf = (text: string, size: number, face: Face = 'sans', tracking = 0): number => {
  const em = face === 'mono' ? 0.6 : 0.56
  return text.length * (size * em + tracking)
}

/** One line, cut with an ellipsis to fit `max` px. */
export const fit = (text: string, max: number, size: number, face: Face = 'sans', tracking = 0): string => {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (widthOf(clean, size, face, tracking) <= max) return clean
  const per = size * (face === 'mono' ? 0.6 : 0.56) + tracking
  const keep = Math.max(0, Math.floor(max / per) - 1)
  return `${clean.slice(0, keep).trimEnd()}…`
}

/** Words wrapped to `max` px, at most `lines` lines, the last cut with an ellipsis if more is left. */
export const wrap = (text: string, max: number, size: number, lines: number, face: Face = 'sans'): string[] => {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const all: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (widthOf(next, size, face) <= max || !line) line = next
    else {
      all.push(line)
      line = word
    }
  }
  if (line) all.push(line)
  const kept = all.slice(0, lines).map(each => fit(each, max, size, face))
  if (all.length > lines && kept.length > 0) {
    const last = kept.length - 1
    const cut = fit(`${kept[last] ?? ''} ${all.slice(lines).join(' ')}`, max, size, face)
    kept[last] = cut.endsWith('…') ? cut : `${cut}…`
  }
  return kept
}

/** The y of a text's baseline, centred in a line box at `top` (what CSS line-height does). */
export const baseline = (top: number, lineHeight: number, size: number): number =>
  Math.round((top + (lineHeight - size) / 2 + size * 0.8) * 100) / 100

type TextOptions = {
  size: number
  fill: string
  face?: Face
  weight?: number
  tracking?: number
  anchor?: 'start' | 'middle' | 'end'
  className?: string
  opacity?: number
}

/** One `<text>`, escaped. */
export const text = (x: number, y: number, content: string, o: TextOptions): string => {
  const family = o.face === 'mono' ? MONO : SANS
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `font-family="${family}"`,
    `font-size="${o.size}"`,
    o.weight ? `font-weight="${o.weight}"` : '',
    o.tracking ? `letter-spacing="${o.tracking}"` : '',
    o.anchor && o.anchor !== 'start' ? `text-anchor="${o.anchor}"` : '',
    `fill="${o.fill}"`,
    o.opacity !== undefined ? `opacity="${o.opacity}"` : '',
    o.className ? `class="${o.className}"` : '',
    'xml:space="preserve"',
  ]
  return `<text ${attrs.filter(Boolean).join(' ')}>${esc(content)}</text>`
}

/** Minutes and seconds, "08:43"; past 99 minutes, hours and minutes, "2h 05m". */
export const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  if (m > 99) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** The time of day, "14:42", in this machine's zone. */
export const timeOfDay = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A whole duration in words for a finished task: "14 MIN", "1 H 05 MIN", "40 S". */
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} S`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} MIN`
  return `${Math.floor(m / 60)} H ${String(m % 60).padStart(2, '0')} MIN`
}

// ---- terminal cells ------------------------------------------------------------------------------

/** Characters a terminal draws two cells wide (East Asian wide and full-width, most emoji). */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u
/** Characters that take no cell of their own (combining marks, joiners, variation selectors). */
const ZERO = /[\p{M}​-‏︀-️]/u

/** How many terminal cells `text` takes. */
export const cellsOf = (text: string): number => {
  let cells = 0
  for (const char of text) cells += ZERO.test(char) ? 0 : WIDE.test(char) ? 2 : 1
  return cells
}

/** `text` cut to at most `max` cells, ending in `ellipsis` when cut. */
export const fitCells = (text: string, max: number, ellipsis = '…'): string => {
  if (cellsOf(text) <= max) return text
  const room = max - cellsOf(ellipsis)
  if (room <= 0) return max > 0 ? ellipsis.slice(0, max) : ''
  let out = ''
  let used = 0
  for (const char of text) {
    const width = ZERO.test(char) ? 0 : WIDE.test(char) ? 2 : 1
    if (used + width > room) break
    out += char
    used += width
  }
  return `${out.trimEnd()}${ellipsis}`
}

/** `text` in lines of at most `max` cells, at most `lines` of them, the last cut with `ellipsis` if more remains. */
export const wrapCells = (text: string, max: number, lines: number, ellipsis = '…'): string[] => {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  const fit = (line: string) => (cellsOf(line) > max ? fitCells(line, max, ellipsis) : line)
  let current = ''
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? ''
    const joined = current ? `${current} ${word}` : word
    if (cellsOf(joined) <= max) {
      current = joined
      continue
    }
    if (out.length === lines - 1) {
      // The last line: whatever is left, cut to fit, ending in the ellipsis.
      out.push(fitCells([current, ...words.slice(index)].filter(Boolean).join(' '), max, ellipsis))
      return out
    }
    if (current) out.push(fit(current))
    current = word
  }
  if (current && out.length < lines) out.push(fit(current))
  return out
}
