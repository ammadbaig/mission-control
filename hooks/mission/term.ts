/**
 * Mission Control as text, for the terminal: the same data and rules as the desktop drawing
 * (draw.ts: the pill, the plan, each agent's look and words, the legend, the timeline), laid out
 * as lines of cells. Pure: state in, lines out; the hooks module turns each line into a row of
 * `Text`. No line is wider than the columns it is given, and every state is a word as well as a
 * colour, so it reads in monochrome too.
 */

import {
  clockAtOf,
  IDLE_LINE,
  legendOf,
  lookOf,
  messageOf,
  modeOf,
  nameOf,
  PILL_WORD,
  planOf,
  progressOf,
  slotsOf,
  STATE_WORD,
  timelineItems,
  updateRow,
  type Slot,
} from './draw'
import type { Look } from './icons'
import { REVIEW_STALE_MS, type MissionData } from './model'
import { cellsOf, clock, duration, fitCells, timeOfDay, wrapCells } from './text'

/** What a piece of text says by its colour; the hooks module maps each to a theme key. */
export type Tone = 'text' | 'strong' | 'dim' | 'working' | 'done' | 'review' | 'needs' | 'failed' | 'paused'
export type Seg = { text: string; tone: Tone }
export type Line = { key: string; segs: Seg[] }
export type TermOptions = { columns: number; rows: number; ascii: boolean }

/** The glyphs, and their plain-ASCII stand-ins for a terminal that cannot draw them. */
type Glyphs = { seg: Record<'done' | 'current' | 'paused' | 'failed' | 'skipped' | 'upcoming', string>; mark: Record<Look, string>; dot: string; more: string }
const UNICODE: Glyphs = {
  seg: { done: '■', current: '▣', paused: '▣', failed: '✕', skipped: '·', upcoming: '□' },
  mark: { working: '▸', done: '✓', needs_user: '?', queued: '◌', idle: '·', in_review: '↺' },
  dot: '·',
  more: '…',
}
const ASCII: Glyphs = {
  seg: { done: 'x', current: '>', paused: '|', failed: '!', skipped: '.', upcoming: '-' },
  mark: { working: '>', done: 'v', needs_user: '?', queued: 'o', idle: '.', in_review: '<' },
  dot: '-',
  more: '...',
}

const TONE_OF: Record<Look, Tone> = { working: 'working', done: 'done', needs_user: 'needs', in_review: 'review', queued: 'dim', idle: 'dim' }
const PILL_TONE = { loading: 'dim', live: 'done', paused: 'paused', offline: 'failed', idle: 'dim' } as const

const seg = (text: string, tone: Tone = 'text'): Seg => ({ text, tone })
const width = (segs: Seg[]): number => segs.reduce((sum, each) => sum + cellsOf(each.text), 0)

/**
 * One line: `left`, then `right` against the right edge. When both do not fit, the left is cut
 * first (with the ellipsis), then the right; never wider than `columns`.
 */
const row = (key: string, left: Seg[], right: Seg[], columns: number, more: string): Line => {
  const fitted = (segs: Seg[], room: number): Seg[] => {
    const out: Seg[] = []
    let left = room
    for (const each of segs) {
      if (left <= 0) break
      const text = cellsOf(each.text) <= left ? each.text : fitCells(each.text, left, more)
      out.push({ ...each, text })
      left -= cellsOf(text)
    }
    return out
  }
  const rightSegs = fitted(right, columns)
  const gap = right.length > 0 && width(rightSegs) > 0 ? 2 : 0
  const leftSegs = fitted(left, Math.max(0, columns - width(rightSegs) - gap))
  const pad = Math.max(0, columns - width(leftSegs) - width(rightSegs))
  return { key, segs: rightSegs.length > 0 ? [...leftSegs, seg(' '.repeat(pad)), ...rightSegs] : leftSegs }
}

/** Lines of `text` wrapped to `columns` (at most `lines`), indented by `indent` cells. */
const block = (key: string, text: string, tone: Tone, columns: number, lines: number, more: string, indent = 0): Line[] =>
  wrapCells(text, Math.max(1, columns - indent), lines, more).map((line, index) => ({ key: `${key}${index}`, segs: [seg(' '.repeat(indent)), seg(line, tone)] }))

/** The title line, and offline's notice under it. */
const top = (data: MissionData, now: number, o: TermOptions, g: Glyphs): Line[] => {
  const mode = modeOf(data, now)
  const lines = [row('title', [seg('Mission Control', 'strong')], [seg(PILL_WORD[mode], PILL_TONE[mode])], o.columns, g.more)]
  if (mode === 'offline') {
    const since = timeOfDay(clockAtOf(data, now, mode))
    lines.push(...block('stale', `No update since ${since} ${g.dot} showing the last known state`, 'dim', o.columns, 2, g.more))
  }
  return lines
}

/** The current task: its title, the segments, the caption. */
const taskLines = (data: MissionData, now: number, o: TermOptions, g: Glyphs, titleLines = 2): Line[] => {
  const state = data.state
  const task = state?.task
  const view = planOf(state, data.events, now)
  if (!task) return [row('task', [seg('No task', 'dim')], [seg('IDLE', 'dim')], o.columns, g.more)]
  const lines = block('task', task.title, 'strong', o.columns, titleLines, g.more)
  const at = clockAtOf(data, now)
  const sep = ` ${g.dot} `
  const paused = view.pausedAt ? `${sep}${timeOfDay(view.pausedAt)}` : ''
  if (view.segments) {
    const bar = view.segments.map(kind => g.seg[kind]).join('')
    const shown = o.ascii ? `[${bar}]` : bar
    const tone: Tone = view.status === 'done' ? 'done' : view.status === 'failed' ? 'failed' : view.status === 'paused' ? 'paused' : 'working'
    lines.push(row('bar', [seg(shown, tone)], [], o.columns, g.more))
  }
  let caption: Seg[]
  if (view.status === 'paused') caption = [seg(view.step ? `PAUSED AT ${view.step.toUpperCase()}` : 'PAUSED', 'paused'), seg(paused, 'dim')]
  else if (view.status === 'done') caption = [seg('DONE', 'done'), seg(`${view.segments ? ` ${view.of} of ${view.of}` : ''}${sep}${duration(view.took ?? 0)}`, 'dim')]
  else if (view.status === 'failed') caption = [seg('FAILED', 'failed'), seg(`${view.segments ? ` ${view.at} of ${view.of}` : ''}${view.reason ? `${sep}${view.reason}` : ''}`, 'dim')]
  else if (!view.segments) caption = [seg('working', 'working'), seg(` ${clock(at - (view.since ?? at))}`, 'dim')]
  else {
    const where = view.at > 0 ? ` ${view.at} of ${view.of}` : ''
    const then = view.next ? `${sep}next ${view.next}` : view.skipped ? `${sep}${view.skipped} skipped` : ''
    caption = [seg((view.step || 'WORKING').toUpperCase(), 'working'), seg(`${where}${then}`, 'dim')]
  }
  lines.push(row('caption', caption, [], o.columns, g.more))
  return lines
}

/** The latest update: who, what, when. */
const latestLine = (data: MissionData, o: TermOptions, g: Glyphs): Line[] => {
  const latest = updateRow(data)
  if (!latest) return [row('latest', [seg('No updates yet', 'dim')], [], o.columns, g.more)]
  return [row('latest', [seg(latest.name, 'strong'), seg('  '), seg(latest.message)], [seg(latest.time, 'dim')], o.columns, g.more)]
}

/** Up next: at most two, then how many more. */
const queueLines = (data: MissionData, o: TermOptions, g: Glyphs): Line[] => {
  const queue = data.state?.queue ?? []
  if (queue.length === 0) return []
  const lines = [row('up', [seg('UP NEXT', 'dim')], [seg(`${queue.length} WAITING`, 'dim')], o.columns, g.more)]
  queue.slice(0, 2).forEach((item, index) => {
    const more = index === 1 && queue.length > 2 ? [seg(`+${queue.length - 2} more`, 'dim')] : []
    lines.push(row(`q${index}`, [seg(`${index + 1}  `, 'dim'), seg(item.text)], more, o.columns, g.more))
  })
  return lines
}

/** The agents: the legend's counts, then one block per agent, in the fixed order (others after). */
const agentLines = (data: MissionData, now: number, o: TermOptions, g: Glyphs, textLines: number): Line[] => {
  const state = data.state
  const mode = modeOf(data, now)
  const offline = mode === 'offline'
  const at = clockAtOf(data, now, mode)
  const legend = legendOf(data, offline)
  const counts = legend.rows.flat().map(entry => `${entry.count} ${entry.word}`)
  const title = offline ? 'LAST KNOWN' : 'AGENTS'
  const lines: Line[] = []
  // The counts beside the title while they fit, else on the lines under it.
  const together = row('agents', [seg(title, 'dim')], [seg(counts.join(` ${g.dot} `), 'dim')], o.columns, g.more)
  if (cellsOf(title) + 2 + cellsOf(counts.join(` ${g.dot} `)) <= o.columns) lines.push(together)
  else {
    lines.push(row('agents', [seg(title, 'dim')], [], o.columns, g.more))
    // Whole counts per line, never one cut in two.
    const rows: string[] = []
    for (const count of counts) {
      const last = rows[rows.length - 1]
      if (last !== undefined && cellsOf(`${last} ${g.dot} ${count}`) <= o.columns) rows[rows.length - 1] = `${last} ${g.dot} ${count}`
      else rows.push(fitCells(count, o.columns, g.more))
    }
    rows.forEach((text, index) => lines.push(row(`counts${index}`, [seg(text, 'dim')], [], o.columns, g.more)))
  }
  const seated = slotsOf(state?.agents ?? [])
  const seatedIds = new Set(seated.map(slot => slot.name.toLowerCase()))
  const extras: Slot[] = (state?.agents ?? []).filter(agent => !seatedIds.has(agent.name.toLowerCase()))
  const hasTask = Boolean(state?.task)
  const nameRoom = Math.max(...[...seated, ...extras].map(slot => cellsOf(slot.name)), 8)
  for (const slot of [...seated, ...extras]) {
    const look = lookOf(state, slot)
    const tone = TONE_OF[look]
    const word = STATE_WORD[look]
    let right: Seg[]
    if (look === 'working' && offline) right = [seg(word, tone), seg(` ${g.dot} last seen ${timeOfDay(at)}`, 'dim')]
    else if (look === 'working') right = [seg(word, tone), seg(` ${clock(at - slot.startedAt)}`, 'dim')]
    else if (look === 'in_review' && at - slot.startedAt > REVIEW_STALE_MS) right = [seg(word, tone), seg(` ${Math.floor((at - slot.startedAt) / 60_000)} min`, 'dim')]
    else right = [seg(word, tone)]
    const name = slot.name.padEnd(nameRoom)
    const key = `a-${slot.name.toLowerCase()}`
    lines.push(row(key, [seg(`${g.mark[look]} `, tone), seg(name, look === 'idle' || look === 'queued' ? 'dim' : 'strong')], right, o.columns, g.more))
    if (textLines === 0) continue
    const message = messageOf(slot, look, hasTask) || (hasTask ? IDLE_LINE.inTask : IDLE_LINE.noTask)
    lines.push(...block(`${key}-t`, message, look === 'idle' || look === 'queued' ? 'dim' : 'text', o.columns, textLines, g.more, 2))
    const own = look === 'working' ? progressOf(data.events, slot) : ''
    if (own) lines.push(...block(`${key}-p`, own, 'dim', o.columns, textLines, g.more, 2))
  }
  return lines
}

/**
 * The overview, top to bottom, fitted to the pane's rows where it can be: each agent's task in two
 * lines, then one; then without the blank lines between sections; then the agents' rows alone and
 * the title in one line. The state rows always stay; what still does not fit scrolls.
 */
export function overviewLines(data: MissionData, now: number, o: TermOptions): Line[] {
  const g = o.ascii ? ASCII : UNICODE
  // A blank line is one space: an empty Text takes no row in the terminal.
  const build = (textLines: number, gaps: boolean, titleLines: number) => {
    const blank = (key: string): Line[] => (gaps ? [{ key, segs: [seg(' ')] }] : [])
    return [
      ...top(data, now, o, g),
      ...blank('b1'),
      ...taskLines(data, now, o, g, titleLines),
      ...latestLine(data, o, g),
      ...(data.state?.queue.length ? [...blank('b2'), ...queueLines(data, o, g)] : []),
      ...blank('b3'),
      ...agentLines(data, now, o, g, textLines),
    ]
  }
  const tries: [number, boolean, number][] = [
    [2, true, 2],
    [1, true, 2],
    [1, false, 2],
    [0, false, 1],
  ]
  for (const [textLines, gaps, titleLines] of tries) {
    const lines = build(textLines, gaps, titleLines)
    if (lines.length <= o.rows) return lines
  }
  return build(0, false, 1)
}

/** The Activity view: every event, newest first, grouped as on the desktop (a run of one agent's lines under one name). */
export function activityLines(data: MissionData, o: TermOptions): Line[] {
  const g = o.ascii ? ASCII : UNICODE
  const lines: Line[] = [row('title', [seg('Activity', 'strong')], [seg(`${data.events.length} events`, 'dim')], o.columns, g.more)]
  if (data.state?.task) lines.push(...block('task', data.state.task.title, 'dim', o.columns, 1, g.more))
  lines.push({ key: 'gap', segs: [seg(' ')] })
  if (data.events.length === 0) return [...lines, row('none', [seg('Nothing yet', 'dim')], [], o.columns, g.more)]
  const items = timelineItems(data.events)
  // Time (5), two spaces; the name column as wide as the widest name, two spaces; then the text.
  const nameRoom = Math.min(14, Math.max(4, ...items.flatMap(item => item.events.slice(0, 1).map(event => cellsOf(nameOf(event))))))
  const textAt = 5 + 2 + nameRoom + 2
  items.forEach((item, itemIndex) => {
    item.events.forEach((event, eventIndex) => {
      const quiet = event.from.trim().toLowerCase() === 'orchestrator'
      const name = eventIndex === 0 ? fitCells(nameOf(event), nameRoom, g.more).padEnd(nameRoom) : ' '.repeat(nameRoom)
      const words = event.side ? `Other task ${g.dot} ${event.text}` : event.text
      const room = o.columns - textAt
      const key = `e${itemIndex}-${eventIndex}`
      if (room < 12) {
        // Too narrow for columns: time and name on one line, the text under them.
        lines.push(row(key, [seg(timeOfDay(event.time), 'dim'), seg('  '), seg(name.trim(), quiet ? 'dim' : 'strong')], [], o.columns, g.more))
        lines.push(...block(`${key}-t`, words, quiet ? 'dim' : 'text', o.columns, 2, g.more, 2))
        return
      }
      const [first = '', ...rest] = wrapCells(words, room, 2, g.more)
      lines.push({ key, segs: [seg(timeOfDay(event.time), itemIndex === 0 && eventIndex === 0 ? 'working' : 'dim'), seg('  '), seg(name, quiet ? 'dim' : 'strong'), seg('  '), seg(first, quiet ? 'dim' : 'text')] })
      rest.forEach((line, index) => lines.push({ key: `${key}-${index}`, segs: [seg(' '.repeat(textAt)), seg(line, quiet ? 'dim' : 'text')] }))
    })
  })
  return lines
}

/** A line's text, as a terminal shows it (for tests and the plain readout). */
export const plainOf = (line: Line): string => line.segs.map(each => each.text).join('')
