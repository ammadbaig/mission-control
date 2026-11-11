import { avatar, chevronRight, dot, liveBars, orbit, ORCH_DISC_R, orchestratorNode, orchRingOf, type Look } from './icons'
import { isOffline, ORCH_LABELS, orchestratorOf, REVIEW_STALE_MS, type McAgent, type McEvent, type McState, type McStep, type MissionData } from './model'
import { baseline, clock, duration, fit, text, timeOfDay, widthOf, wrap } from './text'
import { alpha, TOKENS, W, type Actor, type ThemeMode, type Tokens } from './tokens'

/**
 * Mission Control's drawings, as pure functions: data, the time and the theme in, SVG documents
 * out. Each section is its own document so a change redraws only that part, and loops stay in
 * phase on a redraw (each loop's delay is set back by the time already run). Timers count in CSS,
 * so no drawing changes every second. Backgrounds are transparent: the pane's own shows through.
 * In `auto` each document carries both token sets and `prefers-color-scheme` picks one.
 */

export type Piece = { key: string; svg: string; height: number; width: number; alt: string }

/** The latest update as the native row draws it (a drawn row can't be pressed). */
export type UpdateRow = { name: string; message: string; time: string } | null

type Ctx = {
  now: number
  /** Motion is on: the feed is live. Offline, nothing moves and the data is greyed. */
  motion: boolean
  offline: boolean
  /** A unique prefix for ids inside one document (theme included). */
  id: string
  T: Tokens
  mode: Mode
  /** The time the timers show: now while live; when it went quiet (offline) or was paused. */
  clockAt: number
}

const offlineOf = (data: MissionData, now: number): boolean => modeOf(data, now) === 'offline'

/**
 * How the pane stands: loading (nothing read yet); live; paused (the orchestrator stopped the task
 * on purpose); offline (a running task with nothing written for a minute); idle (no task running,
 * and the circle says IDLE). With no task running the chip follows the circle, from the same value:
 * LIVE while it shows anything but IDLE (its 30 seconds of DONE included), IDLE in the same draw as it.
 */
export type Mode = 'loading' | 'live' | 'paused' | 'offline' | 'idle'
export const modeOf = (data: MissionData, now: number): Mode => {
  if (!data.loaded) return 'loading'
  const state = data.state
  const task = state?.task
  if (task?.status === 'paused') return 'paused'
  if (task?.status === 'running') return data.offline || isOffline(state, now, data.aliveAt) ? 'offline' : 'live'
  return orchestratorOf(state, now).status === 'idle' ? 'idle' : 'live'
}

const m = (ctx: Ctx, classes: string): string => (ctx.motion ? classes : '')
/** A loop's delay, set back by how far it has run, so a redrawn loop carries on where it was. */
const phase = (ctx: Ctx, periodMs: number): string => `animation-delay:-${ctx.now % periodMs}ms`

/** Every document's CSS: the loops, the one-shots, reduced motion (fades only) and the theme switch. */
const STYLE = [
  // Both schemes declared, so a frame drawing this on the app's dark background stays
  // transparent (without it Chromium paints a frame of another scheme opaque white).
  ':root{color-scheme:light dark}',
  '.m{animation-timing-function:linear;animation-iteration-count:infinite}',
  '@keyframes spin{to{transform:rotate(360deg)}}',
  '.spin{transform-box:fill-box;transform-origin:center;animation-name:spin;animation-duration:24s}',
  '.spin.fast{animation-duration:8s}',
  '@keyframes flow{to{transform:translateX(9.72px)}}',
  '.flow{animation-name:flow;animation-duration:0.9s}',
  '@keyframes breathe{0%,100%{opacity:1}50%{opacity:0.5}}',
  '.breathe{animation-name:breathe;animation-duration:2.4s;animation-timing-function:ease-in-out}',
  '@keyframes eq{0%,100%{transform:scaleY(1)}50%{transform:scaleY(0.4)}}',
  '.eq{transform-box:fill-box;transform-origin:50% 100%;animation-name:eq;animation-duration:0.9s;animation-timing-function:ease-in-out}',
  '.eq1{animation-delay:-0.3s}.eq2{animation-delay:-0.6s}',
  '@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}',
  '.pulse{animation-name:pulse;animation-duration:2s;animation-timing-function:ease-in-out}',
  '@keyframes sweep{from{transform:translateX(-140px)}to{transform:translateX(360px)}}',
  '.sweep{animation-name:sweep;animation-duration:1.6s;animation-timing-function:ease-in-out}',
  '@keyframes skel{0%,100%{opacity:0.45}50%{opacity:0.9}}',
  '.skel{animation-name:skel;animation-duration:1.4s;animation-timing-function:ease-in-out}',
  '@keyframes ripple{from{transform:scale(1);opacity:0.85}to{transform:scale(2.1);opacity:0}}',
  '@keyframes fadeout{from{opacity:0.85}to{opacity:0}}',
  // Hidden until it starts (its delay), so a ring set for a shot's arrival never shows at its departure.
  '.rip{transform-box:fill-box;transform-origin:center;opacity:0;animation:ripple 400ms ease-out forwards}',
  '@media (prefers-reduced-motion: reduce){.m{animation:none!important}.pk{display:none}.rip{animation-name:fadeout}}',
  '.th-light{display:none}',
  '@media (prefers-color-scheme: light){.th-dark{display:none}.th-light{display:inline}}',
].join('')

/**
 * One document: `paint` draws it with one token set. `auto` draws it twice, a group per theme, and
 * the CSS above shows the one that matches the frame's colour scheme.
 */
/**
 * A drawing the app shows in a frame narrower than its width is shrunk to fit and, by default,
 * centred: a tall one (the Activity list, thousands of px) then gets a band above it of half the
 * height it lost (at 95%, about 70px over the list). `top` pins the picture to the frame's top, so
 * any band falls below it.
 */
const doc = (
  theme: ThemeMode,
  width: number,
  height: number,
  paint: (T: Tokens) => { body: string; style?: string },
  top = false,
): string => {
  const sets = theme === 'auto' ? [TOKENS.dark, TOKENS.light] : [TOKENS[theme]]
  const painted = sets.map(T => ({ T, ...paint(T) }))
  const body =
    theme === 'auto' ? painted.map(({ T, body: part }) => `<g class="th-${T.name}">${part}</g>`).join('') : (painted[0]?.body ?? '')
  const style = painted.map(({ style: extra }) => extra ?? '').join('')
  const pinned = top ? ' preserveAspectRatio="xMidYMin meet"' : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"${pinned} fill="none"><style>${STYLE}${style}</style>${body}</svg>`
}

/** The time the timers show: now while live; when it went quiet (offline) or was paused. */
export const clockAtOf = (data: MissionData, now: number, mode: Mode = modeOf(data, now)): number =>
  mode === 'offline' ? Math.max(data.state?.lastUpdated ?? 0, data.aliveAt ?? 0) || now : mode === 'paused' ? (data.state?.task?.pausedAt ?? now) : now

const ctxFor = (data: MissionData, now: number, base: string, T: Tokens): Ctx => {
  const mode = modeOf(data, now)
  const offline = mode === 'offline'
  const clockAt = clockAtOf(data, now, mode)
  // Only a live pane moves (a loading one pulses its placeholders).
  return { now, motion: mode === 'live' || mode === 'loading', offline, id: `${base}${T.name[0]}`, T, mode, clockAt }
}

const hline = (T: Tokens, y: number, x1 = 0, x2 = W): string => `<path d="M${x1} ${y + 0.5}H${x2}" stroke="${T.line}" stroke-width="1"/>`

/** Label styles from the spec's type table (mono, upper case). */
const label = (
  x: number,
  top: number,
  content: string,
  fill: string,
  o: { size?: number; tracking?: number; weight?: number; anchor?: 'start' | 'end' | 'middle' } = {},
) => {
  const size = o.size ?? 10
  return text(x, baseline(top, 12, size), content, {
    size,
    fill,
    face: 'mono',
    weight: o.weight ?? 500,
    tracking: o.tracking ?? 1,
    anchor: o.anchor ?? 'start',
  })
}

const greyed = (ctx: Ctx, content: string): string => (ctx.offline ? `<g opacity="0.6">${content}</g>` : content)

/**
 * A clock that counts up in CSS: each digit is a strip of figures stepped by its own loop, set back
 * by the time already run, so it ticks every second with no redraw. Stopped (offline), plain text.
 */
const liveClock = (
  ctx: Ctx,
  key: string,
  x: number,
  y: number,
  elapsedMs: number,
  o: { size: number; fill: string; weight?: number; tracking?: number; anchor?: 'start' | 'end' },
): string => {
  const shown = clock(elapsedMs)
  const advance = o.size * 0.6 + (o.tracking ?? 0)
  const width = shown.length * advance
  const x0 = o.anchor === 'end' ? x - width : x
  if (!ctx.motion || shown.length !== 5) {
    return text(x0, y, shown, { size: o.size, fill: o.fill, face: 'mono', weight: o.weight, tracking: o.tracking })
  }
  const line = Math.round(o.size * 1.6)
  const clipId = `${ctx.id}-${key}`
  const seconds = elapsedMs / 1000
  // m-tens, m-ones, ":", s-tens, s-ones: [count, period in s]
  const digits: [number, number][] = [
    [10, 6000],
    [10, 600],
    [0, 0],
    [6, 60],
    [10, 10],
  ]
  const parts = digits
    .map(([count, period], index) => {
      const at = x0 + index * advance
      if (count === 0) return text(at, y, ':', { size: o.size, fill: o.fill, face: 'mono', weight: o.weight })
      const figures = Array.from({ length: count }, (_, figure) =>
        text(at, y + figure * line, String(figure), { size: o.size, fill: o.fill, face: 'mono', weight: o.weight }),
      ).join('')
      return `<g style="animation:tk${count}x${line} ${period}s steps(${count}) infinite;animation-delay:-${seconds}s">${figures}</g>`
    })
    .join('')
  return `<defs><clipPath id="${clipId}"><rect x="${x0 - 1}" y="${y - o.size}" width="${width + 2}" height="${Math.round(o.size * 1.3)}"/></clipPath></defs><g clip-path="url(#${clipId})">${parts}</g>`
}

/** The keyframes the clocks use, for each strip length and line height a document needs. */
const clockStyle = (lines: number[]): string =>
  [...new Set(lines)]
    .flatMap(line => [6, 10].map(count => `@keyframes tk${count}x${line}{to{transform:translateY(-${count * line}px)}}`))
    .join('')

// ---- header -----------------------------------------------------------------------------------

/** The LIVE / OFFLINE / SYNCING pill, its right edge at `right`, centred on `cy`. */
export const PILL_WORD: Record<Mode, string> = { loading: 'SYNCING', live: 'LIVE', paused: 'PAUSED', offline: 'OFFLINE', idle: 'IDLE' }

/**
 * The pill: LIVE in green, its dot pulsing; PAUSED in Needs you's amber, built the same way, its dot
 * still; IDLE calm (secondary words, a still dot, an 8% border); OFFLINE and SYNCING quiet (tertiary).
 */
const pillBody = (ctx: Ctx, right: number, cy: number): string => {
  const { T } = ctx
  const word = PILL_WORD[ctx.mode]
  const live = ctx.mode === 'live'
  const looks: Record<Mode, { ink: string; color: string; fill: string; line: string }> = {
    live: { ink: T.ink.done, color: T.done, fill: T.liveFill, line: T.liveLine },
    paused: { ink: T.ink.needs, color: T.needs, fill: T.pausedFill, line: T.pausedLine },
    idle: { ink: T.secondary, color: T.secondary, fill: 'none', line: T.name === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' },
    offline: { ink: T.tertiary, color: T.tertiary, fill: T.quietFill, line: T.quietLine },
    loading: { ink: T.tertiary, color: T.tertiary, fill: T.quietFill, line: T.quietLine },
  }
  const { ink, color, fill, line } = looks[ctx.mode]
  const textWidth = word.length * (9 * 0.6 + 0.9)
  const width = 8 + 6 + 6 + textWidth + 8
  const x = right - width
  return (
    `<rect x="${x + 0.5}" y="${cy - 9.5}" width="${width - 1}" height="19" rx="9.5" fill="${fill}" stroke="${line}"/>` +
    `<circle class="${live ? m(ctx, 'm pulse') : ''}" style="${live ? phase(ctx, 2000) : ''}" cx="${x + 11}" cy="${cy}" r="3" fill="${color}"/>` +
    text(x + 20, baseline(cy - 6, 12, 9), word, { size: 9, fill: ink, face: 'mono', weight: 500, tracking: 0.9 })
  )
}

/** The Overview's space between sections (above the task card); the Activity view keeps the same rhythm. */
export const SECTION_GAP = 12

/** Overview header, 48 tall, and the 12px above the card: orbit, title, the pill. */
export const header = (data: MissionData, now: number, theme: ThemeMode): Piece => {
  const height = 48 + SECTION_GAP
  const svg = doc(theme, W, height, T => {
    const ctx = ctxFor(data, now, 'hd', T)
    const titleWidth = widthOf('Mission Control', 13) - 6
    return {
      // No ambient glow (p1-50da7): clipped to this 400px column it showed as a band in a wider pane.
      body:
        orbit(T, 16, 15) +
        text(42, baseline(16, 16, 13), 'Mission Control', { size: 13, fill: T.text, weight: 600 }) +
        text(42 + titleWidth + 8, baseline(16, 16, 10), '/ MY TEAM', { size: 10, fill: T.tertiary, face: 'mono', tracking: 0.8 }) +
        pillBody(ctx, W - 16, 24) +
        hline(T, 47),
    }
  })
  return { key: 'header', svg, height, width: W, alt: `Mission Control, ${PILL_WORD[modeOf(data, now)].toLowerCase()}` }
}

/** The pill alone, for the Activity view's native header row (48 tall, to centre in it). */
export const pill = (data: MissionData, now: number, theme: ThemeMode): Piece => {
  const width = 76
  const svg = doc(theme, width, 48, T => ({ body: pillBody(ctxFor(data, now, 'pl', T), width - 16, 24) }))
  const word = PILL_WORD[modeOf(data, now)]
  return { key: 'pill', svg, height: 48, width, alt: `${word[0]}${word.slice(1).toLowerCase()}` }
}

/** Offline: one line under the header saying since when the pane shows old news. */
export const NOTICE_H = 22
export const staleNotice = (data: MissionData, now: number, theme: ThemeMode): Piece | null => {
  if (modeOf(data, now) !== 'offline') return null
  const since = timeOfDay(Math.max(data.state?.lastUpdated ?? 0, data.aliveAt ?? 0) || now)
  const words = `No update since ${since} · showing the last known state`
  const svg = doc(theme, W, NOTICE_H, T => ({ body: text(16, baseline(0, 14, 11), words, { size: 11, fill: T.tertiary }) }))
  return { key: 'notice', svg, height: NOTICE_H, width: W, alt: words }
}

// ---- progress ---------------------------------------------------------------------------------

type Caption = { left: string; leftColor: string; count: string; right: string; clockFrom?: number }

/** How one plan step is drawn: done, the current one, the one a paused task stopped at, the one it failed at, skipped, or still to come. */
export type SegmentKind = 'done' | 'current' | 'paused' | 'failed' | 'skipped' | 'upcoming'

/**
 * The task's progress as plain facts, shared by the desktop drawing and the terminal's text: the
 * segments (null with no plan) and what the caption says. One place for the rules of which step is
 * current, where a task failed or paused, what comes next and how long a finished one took.
 */
export type PlanView = {
  status: 'none' | 'running' | 'paused' | 'done' | 'failed'
  segments: SegmentKind[] | null
  /** The current step's label (running), the one it paused at, or ''. */
  step: string
  /** 1-based: the current step (running), or the one it failed at; 0 when none. */
  at: number
  of: number
  next: string
  skipped: string
  /** Paused: when. Done: how long it took. Failed: why. Running with no plan: since when. */
  pausedAt?: number
  took?: number
  reason: string
  since?: number
}

export const planOf = (state: McState | null, events: McEvent[], now: number): PlanView => {
  const task = state?.task ?? null
  const plan: McStep[] | null = state?.plan ?? null
  const base = { segments: null, step: '', at: 0, of: plan?.length ?? 0, next: '', skipped: '', reason: '' }
  if (!task) return { ...base, status: 'none', of: 0 }
  const reason = () => {
    const failed = [...events].reverse().find(event => event.type === 'task_failed') ?? events[events.length - 1]
    return failed?.text ?? ''
  }
  const took = (task.finishedAt ?? now) - task.startedAt
  const pausedAt = task.pausedAt ? { pausedAt: task.pausedAt } : {}
  if (!plan) {
    if (task.status === 'paused') return { ...base, status: 'paused', ...pausedAt }
    if (task.status === 'done') return { ...base, status: 'done', took }
    if (task.status === 'failed') return { ...base, status: 'failed', reason: reason() }
    return { ...base, status: 'running', since: task.startedAt }
  }
  const n = plan.length
  const activeIndex = plan.findIndex(step => step.status === 'active')
  const failedAt = task.status === 'failed' ? (activeIndex >= 0 ? activeIndex : plan.findIndex(step => step.status === 'pending')) : -1
  const segments: SegmentKind[] = plan.map((step, index) => {
    if (task.status === 'done') return 'done'
    if (index === failedAt) return 'failed'
    if (step.status === 'done') return 'done'
    if (step.status === 'active') return task.status === 'paused' ? 'paused' : 'current'
    if (step.status === 'skipped') return 'skipped'
    return 'upcoming'
  })
  if (task.status === 'done') return { ...base, status: 'done', segments, at: n, took }
  if (task.status === 'failed') return { ...base, status: 'failed', segments, at: failedAt >= 0 ? failedAt + 1 : n, reason: reason() }
  const active = plan[activeIndex]
  if (task.status === 'paused') {
    const step = active?.label ?? plan.find(each => each.status === 'pending')?.label ?? ''
    return { ...base, status: 'paused', segments, step, ...pausedAt }
  }
  const next = activeIndex >= 0 ? plan.slice(activeIndex + 1).find(step => step.status === 'pending') : plan.find(step => step.status === 'pending')
  const skipped = next ? undefined : [...plan].reverse().find(step => step.status === 'skipped')
  return { ...base, status: 'running', segments, step: active?.label ?? '', at: activeIndex >= 0 ? activeIndex + 1 : 0, next: next?.label ?? '', skipped: skipped?.label ?? '' }
}

/** The segments and their caption, for whatever plan is reported (drawn from planOf). */
const progress = (
  ctx: Ctx,
  state: McState | null,
  events: McEvent[],
  x: number,
  y: number,
  width: number,
  h: number,
): { bars: string; caption: Caption } => {
  const { T } = ctx
  const view = planOf(state, events, ctx.now)
  const radius = Math.min(2, h / 2)
  const seg = (sx: number, sw: number, fill: string, extra = '') =>
    `<rect x="${sx}" y="${y}" width="${Math.max(sw, 1)}" height="${h}" rx="${radius}" fill="${fill}"${extra}/>`
  const glow = ` style="filter:drop-shadow(0 0 4px ${alpha(T.working, T.glowNow)})"`
  const pausedRight = view.pausedAt ? timeOfDay(view.pausedAt) : ''

  if (view.status === 'none') {
    return { bars: seg(x, width, T.track), caption: { left: 'IDLE', leftColor: T.tertiary, count: '', right: 'NO TASK' } }
  }
  if (!view.segments) {
    if (view.status === 'paused') return { bars: seg(x, width, T.track), caption: { left: 'PAUSED', leftColor: T.secondary, count: '', right: pausedRight } }
    if (view.status === 'done') return { bars: seg(x, width, T.doneSoft), caption: { left: 'DONE', leftColor: T.ink.done, count: '', right: duration(view.took ?? 0) } }
    if (view.status === 'failed') return { bars: seg(x, width, T.failedSoft), caption: { left: 'FAILED', leftColor: T.ink.failed, count: '', right: view.reason } }
    // Open-ended: one track, a cyan sweep moving along it.
    const clipId = `${ctx.id}-track`
    const sweep = ctx.motion
      ? `<g clip-path="url(#${clipId})"><rect class="m sweep" style="${phase(ctx, 1600)}" x="${x}" y="${y}" width="140" height="${h}" fill="url(#${ctx.id}-sweep)"/></g>`
      : seg(x, width, `url(#${ctx.id}-still)`)
    const defs =
      `<defs><clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${width}" height="${h}" rx="${radius}"/></clipPath>` +
      `<linearGradient id="${ctx.id}-sweep" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${T.working}" stop-opacity="0"/><stop offset="0.5" stop-color="${T.working}"/><stop offset="1" stop-color="${T.working}" stop-opacity="0"/></linearGradient>` +
      `<linearGradient id="${ctx.id}-still" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${T.track}"/><stop offset="0.32" stop-color="${T.working}"/><stop offset="0.6" stop-color="${T.track}"/><stop offset="1" stop-color="${T.track}"/></linearGradient></defs>`
    return {
      bars: defs + seg(x, width, T.track) + sweep,
      caption: { left: 'WORKING', leftColor: T.ink.working, count: '', right: 'NO PLAN', ...(view.since !== undefined ? { clockFrom: view.since } : {}) },
    }
  }

  const n = view.segments.length
  const sw = (width - 4 * (n - 1)) / n
  const bars = view.segments
    .map((kind, index) => {
      const sx = x + index * (sw + 4)
      switch (kind) {
        case 'done':
          return seg(sx, sw, T.doneSoft)
        case 'failed':
          return seg(sx, sw, T.failedSoft)
        case 'paused':
          // Paused: the step it stopped at, in a still neutral tone.
          return seg(sx, sw, T.secondary)
        case 'current':
          return seg(sx, sw, T.working, ctx.motion ? glow : '')
        case 'skipped':
          return `<rect x="${sx + 0.5}" y="${y + 0.5}" width="${Math.max(sw - 1, 1)}" height="${Math.max(h - 1, 1)}" rx="${radius}" fill="none" stroke="${T.skipLine}" stroke-dasharray="2 2"/>`
        default:
          return seg(sx, sw, T.track)
      }
    })
    .join('')

  if (view.status === 'done') return { bars, caption: { left: 'DONE', leftColor: T.ink.done, count: `${n} OF ${n}`, right: duration(view.took ?? 0) } }
  if (view.status === 'failed') return { bars, caption: { left: 'FAILED', leftColor: T.ink.failed, count: `${view.at} OF ${n}`, right: view.reason } }
  if (view.status === 'paused') {
    return { bars, caption: { left: view.step ? `PAUSED AT ${view.step.toUpperCase()}` : 'PAUSED', leftColor: T.secondary, count: '', right: pausedRight } }
  }
  let right = ''
  if (view.next) right = `NEXT  ${view.next.toUpperCase()}`
  else if (view.skipped) right = `${view.skipped.toUpperCase()} SKIPPED`
  return {
    bars,
    caption: { left: (view.step || 'WORKING').toUpperCase(), leftColor: T.ink.working, count: view.at > 0 ? `${view.at} OF ${n}` : '', right },
  }
}

/** The caption row under the segments. */
const captionRow = (ctx: Ctx, caption: Caption, x: number, top: number, width: number): string => {
  const { T } = ctx
  const per = 10 * 0.6 + 0.6
  const y = baseline(top, 12, 10)
  const leftText = fit(caption.left, width * 0.45, 10, 'mono', 0.6)
  let out = text(x, y, leftText, { size: 10, fill: caption.leftColor, face: 'mono', weight: 500, tracking: 0.6 })
  let cursor = x + leftText.length * per + 8
  if (caption.clockFrom !== undefined) {
    out += liveClock(ctx, 'cap', cursor, y, ctx.clockAt - caption.clockFrom, { size: 10, fill: T.tertiary, tracking: 0.6 })
    cursor += 5 * per
  } else if (caption.count) {
    out += text(cursor, y, caption.count, { size: 10, fill: T.tertiary, face: 'mono', tracking: 0.6 })
    cursor += caption.count.length * per
  }
  if (caption.right) {
    const room = x + width - cursor - 12
    out += text(x + width, y, fit(caption.right, room, 10, 'mono', 0.6), {
      size: 10,
      fill: T.tertiary,
      face: 'mono',
      tracking: 0.6,
      anchor: 'end',
    })
  }
  return out
}

// ---- current task -----------------------------------------------------------------------------

/** Who an event is from, as the panel shows it: the first letter capitalised (ids are written lower-case). */
export const nameOf = (event: McEvent): string => {
  const who = event.from || event.type.replace('_', ' ')
  return `${who[0]?.toUpperCase() ?? ''}${who.slice(1)}`
}

/**
 * The task card is drawn in four pieces so its update row can be a native, pressable
 * row with no native outline to line up: the top (border, gradient, label, title, progress,
 * divider), the row's two ends (its side borders, the dot, the time and chevron), and the bottom.
 * Between the ends the row is native text on the pane's own ground, so the card has no surface
 * fill anywhere (a native fill could never match a drawn one in both themes); its outline and the
 * violet top gradient carry it.
 */
export const CARD_W = 376
const R = 14
/** The card's top: 1px border, 14 padding, label 12, 8, title 44, 14, progress 24, 14, divider 1, 12. */
export const CARD_TOP = 144
/** The card's bottom: 14 padding and the 1px border. */
export const CARD_CAP = 15
/** Where the row's words start: 1px border + 14 + the 6px dot + 8. */
export const ROW_LEFT = 29

export const taskTop = (data: MissionData, now: number, theme: ThemeMode): Piece => {
  const height = CARD_TOP
  const task = data.state?.task ?? null
  let alt = 'Current task: nothing is running'
  const svg = doc(theme, CARD_W, height, T => {
    const ctx = ctxFor(data, now, 'tk', T)
    const ix = 15
    const iw = CARD_W - 30
    const edge = `M0.5 ${height}V${R + 0.5}A${R} ${R} 0 0 1 ${R + 0.5} 0.5H${CARD_W - R - 0.5}A${R} ${R} 0 0 1 ${CARD_W - 0.5} ${R + 0.5}V${height}`
    const gradient =
      `<defs><linearGradient id="${ctx.id}-bg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${T.orch}" stop-opacity="0.07"/><stop offset="1" stop-color="${T.orch}" stop-opacity="0.01"/></linearGradient></defs>` +
      `<path d="${edge}Z" fill="url(#${ctx.id}-bg)"/><path d="${edge}" stroke="${T.line}"/>`
    let content = label(ix, 15, 'CURRENT TASK', T.tertiary)
    wrap(task ? task.title : 'Nothing is running', iw, 15, 2).forEach((line, index) => {
      content += text(ix, baseline(35 + index * 22, 22, 15), line, { size: 15, fill: task ? T.text : T.secondary, weight: 500 })
    })
    const { bars, caption } = progress(ctx, data.state, data.events, ix, 93, iw, 4)
    content += bars + captionRow(ctx, caption, ix, 105, iw) + hline(T, 131, ix, ix + iw)
    if (task) alt = `Current task: ${task.title}. ${caption.left} ${caption.count}`
    return { body: gradient + greyed(ctx, content), style: clockStyle([16]) }
  })
  return { key: 'task-top', svg, height, width: CARD_W, alt }
}

/** The latest update, for the native row: who, what, when. */
/**
 * The task card's latest update: the newest event of the current task (by its taskId, side work
 * left out), else "Orchestrator · Started" at the task's start (a task started by an older writer);
 * never a line from another task. With no task, the newest event, whatever it is.
 */
export const updateRow = (data: MissionData): UpdateRow => {
  const task = data.state?.task
  if (!task) {
    const latest = data.events[data.events.length - 1]
    return latest ? { name: nameOf(latest), message: latest.text, time: timeOfDay(latest.time) } : null
  }
  const own = data.events.findLast(event => event.taskId === task.id && !event.side)
  return own ? { name: nameOf(own), message: own.text, time: timeOfDay(own.time) } : { name: 'Orchestrator', message: 'Started', time: timeOfDay(task.startedAt) }
}

/** The longest name the row draws before cutting it. */
const ROW_NAME_MAX = 150

/**
 * The latest-update row, drawn whole, `h` tall (one cell, so a native overlay of the
 * same height can lie over it and take the press): the card's side borders, the glowing dot
 *, who (12px Medium, primary), what (12px Regular, secondary, cut to fit), when
 * (10px mono, tertiary) and the chevron.
 */
/** A row with nothing in it: the chevron and the end bands are drawn from it, so they never change. */
const EMPTY_ROW: MissionData = { loaded: true, state: null, events: [], eventCount: 0, fresh: [], readAt: 0, offline: false }

export const updateRowPiece = (data: MissionData, now: number, theme: ThemeMode, h: number, dim?: boolean): Piece => {
  const row = updateRow(data)
  const svg = doc(theme, CARD_W, h, T => {
    const base = ctxFor(data, now, 'ur', T)
    // The still bands follow the row's own greying (offline), not their empty data's.
    const ctx = dim === undefined ? base : { ...base, offline: dim }
    const color = row ? T.working : T.tertiary
    const y = baseline((h - 16) / 2, 16, 12)
    const chevronX = CARD_W - 1 - 14 - 14
    const timeEnd = chevronX - 8
    let words = ''
    if (row) {
      const name = fit(row.name, ROW_NAME_MAX, 12)
      const messageX = ROW_LEFT + widthOf(name, 12) + 8
      const room = timeEnd - 30 - 8 - messageX
      words =
        text(ROW_LEFT, y, name, { size: 12, fill: T.text, weight: 500 }) +
        (room > 20 ? text(messageX, y, fit(row.message, room, 12), { size: 12, fill: T.secondary }) : '') +
        text(timeEnd, baseline((h - 16) / 2, 16, 10), row.time, { size: 10, fill: T.tertiary, face: 'mono', anchor: 'end' })
    } else {
      words = text(ROW_LEFT, y, 'No updates yet', { size: 12, fill: T.tertiary })
    }
    return {
      body:
        `<path d="M0.5 0V${h}M${CARD_W - 0.5} 0V${h}" stroke="${T.line}"/>` +
        greyed(
          ctx,
          `<circle cx="18" cy="${h / 2}" r="3" fill="${color}" style="filter:drop-shadow(0 0 3px ${alpha(T.working, T.glowDot)})"/>` +
            words +
            chevronRight(T, chevronX, (h - 14) / 2),
        ),
    }
  })
  const alt = row ? `Latest update from ${row.name} at ${row.time}: ${row.message}. Opens the activity` : 'No updates yet'
  return { key: 'update-row', svg, height: h, width: CARD_W, alt }
}

/**
 * Back, as the design draws it: a 28 x 28 square (white 5% / black 4%, the 8% line, 8px
 * corners) with the chevron-left (p2-fcaf3) in it, 12px in from the left, and the 8px gap after
 * it, so the title that follows starts at the design's x 48. 48 x 48, the header's height.
 */
export const backPiece = (theme: ThemeMode): Piece => ({
  key: 'back',
  svg: doc(theme, 48, 48, T => ({
    body:
      `<rect x="12.5" y="10.5" width="27" height="27" rx="8" fill="${T.name === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'}" stroke="${T.line}"/>` +
      `<path transform="translate(19 17)" d="M8.5 3.5L5 7L8.5 10.5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke="${T.secondary}" fill="none"/>`,
  })),
  height: 48,
  width: 48,
  alt: 'Back to the overview',
})

/**
 * A band of a drawing, `x` to `x + width` across its full height: the same markup with its root
 * `viewBox` moved, so the bands of one drawing set side by side are that drawing, pixel for pixel.
 * Lets one small part (a chevron) be its own drawing, with a press target exactly over it.
 */
export const slice = (piece: Piece, x: number, width: number, key: string, alt: string): Piece => {
  const whole = `width="${piece.width}" height="${piece.height}" viewBox="0 0 ${piece.width} ${piece.height}"`
  if (!piece.svg.includes(whole)) throw new Error(`slice: ${piece.key} has no root viewBox to move`)
  const svg = piece.svg.replace(whole, `width="${width}" height="${piece.height}" viewBox="${x} 0 ${width} ${piece.height}"`)
  return { key, svg, height: piece.height, width, alt }
}

/** The row's chevron band: 28px centred on the 14px chevron (x 347 to 361), so its target sits on it. */
export const ROW_CHEVRON = { x: CARD_W - 1 - 14 - 14 - 7, width: 28 }
/** Back's square band: the 28px square, 12px in. */
export const BACK_SQUARE = { x: 12, width: 28 }

/** The card's bottom: its 14px padding and the rounded bottom border. */
export const taskCap = (theme: ThemeMode): Piece => ({
  key: 'task-cap',
  svg: doc(theme, CARD_W, CARD_CAP, T => ({
    body: `<path d="M0.5 0V0.5A${R} ${R} 0 0 0 ${R + 0.5} ${R + 0.5}H${CARD_W - R - 0.5}A${R} ${R} 0 0 0 ${CARD_W - 0.5} 0.5V0" stroke="${T.line}"/>`,
  })),
  height: CARD_CAP,
  width: CARD_W,
  alt: 'End of the current task card',
})

// ---- up next ----------------------------------------------------------------------------------

/**
 * Up next: the queue's first two rows; from three on, "+N more" at the right of the
 * second row, so the section never grows. `null` when the queue is empty.
 */
export const upNext = (data: MissionData, now: number, theme: ThemeMode): Piece | null => {
  const queue = data.state?.queue ?? []
  if (queue.length === 0) return null
  const shown = queue.slice(0, 2)
  const more = queue.length - shown.length
  const top = 16
  const boxTop = top + 12 + 8
  const boxHeight = shown.length * 32 + (shown.length - 1) + 2
  const height = boxTop + boxHeight
  const svg = doc(theme, W, height, T => {
    const ctx = ctxFor(data, now, 'up', T)
    let content =
      label(14, top, 'UP NEXT', T.tertiary) +
      label(W - 14, top, `${queue.length} WAITING`, T.secondary, { tracking: 0.6, anchor: 'end' }) +
      `<rect x="12.5" y="${boxTop + 0.5}" width="${W - 25}" height="${boxHeight - 1}" rx="10" fill="${T.surface}" stroke="${T.line}"/>`
    shown.forEach((item, index) => {
      const y = boxTop + 1 + index * 33
      const moreHere = more > 0 && index === shown.length - 1
      const moreText = `+${more} MORE`
      const moreWidth = moreHere ? moreText.length * 6.6 + 12 : 0
      if (index > 0) content += hline(T, y - 1, 13, W - 13)
      content +=
        text(25, baseline(y + 8, 16, 10), String(index + 1).padStart(2, '0'), { size: 10, fill: T.tertiary, face: 'mono' }) +
        text(47, baseline(y + 8, 16, 12), fit(item.text, W - 13 - 12 - 47 - moreWidth, 12), { size: 12, fill: T.secondary })
      if (moreHere) {
        content += text(W - 25, baseline(y + 8, 16, 10), moreText, { size: 10, fill: T.tertiary, face: 'mono', tracking: 0.6, anchor: 'end' })
      }
    })
    return { body: greyed(ctx, content) }
  })
  return { key: 'up-next', svg, height, width: W, alt: `Up next: ${queue.map(item => item.text).join('; ')}` }
}

// ---- agents -----------------------------------------------------------------------------------

const FIXED = ['Explorer', 'Worker', 'Tester', 'Security']
/**
 * Graph-local centres for a graph `g` tall: explorer, worker, tester, security, and
 * the orchestrator. At the design's 140 the top nodes sit at 49, the bottom at 97, the orchestrator at
 * 73; a taller or shorter graph keeps the top row's and bottom row's distance from its edges.
 */
const seatsFor = (g: number): [number, number][] => [
  [63, 49],
  [311, 49],
  [63, g - 43],
  [311, g - 43],
]
const orchFor = (g: number): [number, number] => [187, Math.round(g / 2) + 3]
/** An agent's name under its node: at most this wide, its 12px line box from 16 down (top row) or G - 22 (bottom row). */
const NODE_LABEL_MAX = 90
const nodeLabelTop = (g: number, index: number): number => (index < 2 ? 16 : g - 22)

/** The room the orchestrator's ring keeps from the graph card's top and bottom and from every agent's node and label. */
export const ORCH_CLEAR = 12
/**
 * The orchestrator's circle for a graph `g` tall: the disc at ORCH_DISC_R, unless the ring would come
 * within ORCH_CLEAR of the card's top or bottom, an agent's node or its label; then the whole circle
 * (disc, ring, glow) shrinks just enough. With each gap, for checks.
 */
export const orchCircleFor = (g: number): { disc: number; ring: number; gaps: { top: number; bottom: number; nodes: number; labels: number } } => {
  const [cx, cy] = orchFor(g)
  const seats = seatsFor(g)
  const nodes = Math.min(...seats.map(([x, y]) => Math.hypot(x - cx, y - cy) - 14))
  const labels = Math.min(
    ...seats.map(([x], index) => {
      const top = nodeLabelTop(g, index)
      return Math.hypot(Math.max(x - NODE_LABEL_MAX / 2 - cx, 0, cx - x - NODE_LABEL_MAX / 2), Math.max(top - cy, 0, cy - top - 12))
    }),
  )
  const largest = Math.min(cy, g - cy, nodes, labels) - ORCH_CLEAR
  const disc = Math.min(ORCH_DISC_R, (largest * 22) / 30)
  const ring = orchRingOf(disc)
  return { disc, ring, gaps: { top: cy - ring, bottom: g - cy - ring, nodes: nodes - ring, labels: labels - ring } }
}

/** The agents area's sizes: the graph's height and each card's (the design: 140 and 104). */
export type AgentsSize = { graph: number; card: number }
export const DESIGN_AGENTS: AgentsSize = { graph: 140, card: 104 }
/** The shortest graph whose two rows of nodes (49 from the top, 43 from the bottom) still clear each other. */
const GRAPH_MIN = 124
/** Caps on the agents area's growth: past both, a taller pane's extra height stays empty at the bottom. */
const GRAPH_MAX = 360
/** A card one line taller (4 lines of message), and one line shorter (2 lines). */
const CARD_MAX = 140
const CARD_SHORT = 88
/** Space under the cards, so they don't touch the pane's bottom edge (the panel has no footer). */
const AGENTS_BOTTOM = 12
/** The agents section's height for a size: header 38, the graph, 8, two rows of cards 8 apart, the bottom margin. */
/** The agents area's header: one legend row, or two when the legend wraps (LEGEND_ROW more). */
export const AGENTS_HEAD = 38
export const agentsHeight = (size: AgentsSize, head = AGENTS_HEAD): number => head + size.graph + 8 + size.card * 2 + 8 + AGENTS_BOTTOM

/**
 * How the agents area takes the room the rest leaves (`room`, px): extra height goes to the graph
 * up to GRAPH_MAX, then to the cards up to CARD_MAX; short of room, the graph gives way down to
 * GRAPH_MIN, then the cards drop to two lines. `spare` is what's left (positive) or still over.
 */
export const sizeAgents = (room: number, head = AGENTS_HEAD): AgentsSize & { spare: number } => {
  let extra = room - agentsHeight(DESIGN_AGENTS, head)
  let graph = DESIGN_AGENTS.graph
  let cardH = DESIGN_AGENTS.card
  if (extra >= 0) {
    const toGraph = Math.min(extra, GRAPH_MAX - graph)
    graph += toGraph
    extra -= toGraph
    const toCards = Math.min(Math.floor(extra / 2), CARD_MAX - cardH)
    cardH += toCards
    extra -= toCards * 2
  } else {
    const fromGraph = Math.min(-extra, graph - GRAPH_MIN)
    graph -= fromGraph
    extra += fromGraph
    if (extra < 0) {
      extra += (cardH - CARD_SHORT) * 2
      cardH = CARD_SHORT
    }
  }
  return { graph, card: cardH, spare: extra }
}

export type Slot = McAgent & { placeholder?: boolean }

/**
 * The four seats: the fixed roles in their order (each with its own avatar). An agent with another
 * name (the bot avatar) takes the seat of a role that isn't there, or else of a role that is less
 * engaged than it (idle, then queued): an agent at work says more than one waiting, and one waiting
 * more than one with no part. Any more than that are counted, not seated. A role never mentioned
 * sits idle.
 */
export const slotsOf = (agents: McAgent[]): Slot[] => {
  const isFixed = (agent: McAgent) => FIXED.some(name => name.toLowerCase() === agent.name.toLowerCase())
  const byName = new Map(agents.filter(isFixed).map(agent => [agent.name.toLowerCase(), agent]))
  const extras = agents.filter(agent => !isFixed(agent))
  const seats: Slot[] = FIXED.map(
    name => byName.get(name.toLowerCase()) ?? extras.shift() ?? { id: name.toLowerCase(), name, status: 'idle', currentTask: '', startedAt: 0, placeholder: true },
  )
  const rank = (status: McAgent['status']) => (status === 'idle' ? 0 : status === 'queued' ? 1 : 2)
  for (const yields of [0, 1]) {
    for (let index = seats.length - 1; index >= 0 && extras.length > 0; index--) {
      const seat = seats[index]
      const extra = extras[0]
      if (seat && extra && isFixed(seat) && rank(seat.status) === yields && rank(extra.status) > yields) {
        seats[index] = extras.shift() ?? seat
      }
    }
  }
  return seats
}

/** How a seat is drawn: idle when no task runs, else its agent's status. */
export const lookOf = (state: McState | null, slot: Slot): Look => (!state?.task ? 'idle' : slot.status)

/** Each look's word, the same on the desktop cards and in the terminal. */
export const STATE_WORD: Record<Look, string> = { working: 'WORKING', done: 'DONE', queued: 'QUEUED', needs_user: 'NEEDS YOU', in_review: 'IN REVIEW', idle: 'IDLE' }

/**
 * A link from a node's edge to the orchestrator's (the discs are translucent now, so a link
 * stops at them rather than running under them).
 */
const linkPath = (from: [number, number], to: [number, number], fromR: number, toR: number): string => {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]]
  const length = Math.hypot(dx, dy) || 1
  const [ux, uy] = [dx / length, dy / length]
  const r = (n: number) => Math.round(n * 100) / 100
  return `M${r(from[0] + ux * fromR)} ${r(from[1] + uy * fromR)}L${r(to[0] - ux * toR)} ${r(to[1] - uy * toR)}`
}

/** The working link's dash and gap (p1-9f3f2's segments): one period is two of them. */
const DASH = 4.86

/**
 * A working link (p1-9f3f2): dashes flowing from the orchestrator to the agent, by transform only
 * (transform and opacity only). The dashed line is laid along the link's own axis,
 * one period longer than the link, clipped to it, and slid one period in a loop.
 */
const flowingLink = (ctx: Ctx, key: string, from: [number, number], to: [number, number], fromR: number, toR: number): string => {
  const { T } = ctx
  const [dx, dy] = [from[0] - to[0], from[1] - to[1]]
  const full = Math.hypot(dx, dy) || 1
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  const r = (n: number) => Math.round(n * 100) / 100
  // Local axis: 0 at the orchestrator's edge, + toward the agent's edge.
  const start = toR
  const end = full - fromR
  const period = DASH * 2
  const clipId = `${ctx.id}-flow-${key}`
  const line = `<path d="M${r(start - period)} 0H${r(end)}" stroke="${T.working}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="${DASH} ${DASH}"/>`
  return (
    `<g transform="translate(${r(to[0])} ${r(to[1])}) rotate(${r(angle)})">` +
    `<defs><clipPath id="${clipId}"><rect x="${r(start - 1)}" y="-3" width="${r(end - start + 2)}" height="6"/></clipPath></defs>` +
    `<g clip-path="url(#${clipId})"><g class="${m(ctx, 'm flow')}" style="${phase(ctx, 900)}">${line}</g></g></g>`
  )
}

const link = (ctx: Ctx, look: Look, d: string): string => {
  const { T } = ctx
  switch (look) {
    case 'done':
      return `<path d="${d}" stroke="${T.done}" stroke-opacity="0.45" stroke-width="1.25"/>`
    case 'working':
      return ''
    case 'in_review':
      // Handed in: a solid line in its colour, still (the report's packet has landed).
      return `<path d="${d}" stroke="${T.review}" stroke-opacity="0.75" stroke-width="1.25"/>`
    case 'idle':
      // The faintest line: solid, still.
      return `<path d="${d}" stroke="${T.idle}" stroke-opacity="${T.idleLink}" stroke-width="1"/>`
    case 'needs_user':
      return `<path class="${m(ctx, 'm breathe')}" style="${phase(ctx, 2400)}" d="${d}" stroke="${T.needs}" stroke-opacity="0.7" stroke-width="1.25"/>`
    default:
      return `<path d="${d}" stroke="${T.queued}" stroke-opacity="${T.queuedLink}" stroke-width="1"/>`
  }
}

/** A shot's travel time along its line, with an ease-out. */
export const SHOT_MS = 800
/** A shot's dot radius (its glow and fading tail around it). */
export const SHOT_R = 4
/** The tail: dots that follow the shot this many ms apart, smaller and fainter. */
const TAIL = [
  { lag: 45, r: 3, opacity: 0.5 },
  { lag: 90, r: 2.2, opacity: 0.3 },
  { lag: 135, r: 1.5, opacity: 0.15 },
]
/** A ring's own time (`.rip`). */
const RING_MS = 400
/** How long an outgoing shot's own copy of its line stays after it lands: the graph's repaint is there by then. */
const LINE_HOLD_MS = 700

/**
 * When the shots `fresh` (read at `freshAt`) run, by the clock: each starts when it was read, after
 * any earlier one on the same line (never two dots on one line at once; shots on different lines
 * read together start together). Only the current task's own events, never side work.
 */
export const shotPlan = (data: MissionData, taskId: string | undefined): { event: McEvent; start: number }[] => {
  const free = new Map<string, number>()
  const lineOf = (event: McEvent) => (event.type === 'report' || event.type === 'needs_user' || event.type === 'progress' ? event.from : event.type === 'agent_done' ? event.from || event.text : event.to).toLowerCase()
  return data.fresh
    .map((event, index) => ({ event, read: data.freshAt?.[index] ?? data.readAt }))
    .filter(({ event }) => !event.side && (taskId === undefined || event.taskId === taskId))
    .map(({ event, read }) => {
      const key = lineOf(event)
      const start = Math.max(read, free.get(key) ?? 0)
      if (event.type !== 'progress') free.set(key, start + SHOT_MS)
      return { event, start }
    })
}

/**
 * The shots and pulses for recent events, timed by the clock (each animation's delay is its start
 * less `now`, so a redrawn overlay carries on where it was). One shot per event along its agent's
 * line, played once over SHOT_MS: a brief or a send back out from the centre in Working's colour, an
 * accept out in Done's green, each over its own copy of the line in its new style (so it never
 * crosses empty space while the graph repaints), the agent's node pulsing on arrival; a report in to
 * the centre in In review's pink, a question in Needs you's amber, the centre flashing on arrival.
 * Progress lines only pulse the node. None under reduced motion (`.pk`), nor when the pane is not live.
 */
const packets = (
  ctx: Ctx,
  data: MissionData,
  slots: Slot[],
  gx: number,
  gy: number,
  graphH: number,
  taskId?: string,
): { body: string; style: string; end: number } => {
  const SEATS = seatsFor(graphH)
  const ORCH = orchFor(graphH)
  const { T, now } = ctx
  if (!ctx.motion || data.fresh.length === 0) return { body: '', style: '', end: 0 }
  const seatOf = (name: string): [number, number] | null => {
    const index = slots.findIndex(slot => slot.name.toLowerCase() === name.trim().toLowerCase())
    const seat = index >= 0 ? SEATS[index] : undefined
    return seat ? [seat[0] + gx, seat[1] + gy] : null
  }
  const orch: [number, number] = [ORCH[0] + gx, ORCH[1] + gy]
  const disc = orchCircleFor(graphH).disc
  let body = ''
  let style = ''
  let count = 0
  let end = 0
  const delayOf = (at: number) => `animation-delay:${Math.round(at - now)}ms`
  /** One shot from `start` along the line between the centre and `seat`; `look` draws the line it rides (outgoing). */
  const leg = (seat: [number, number], outward: boolean, color: string, start: number, look?: Look) => {
    const [from, to] = outward ? [orch, seat] : [seat, orch]
    const name = `${ctx.id}pk${count++}`
    if (look) {
      const d = linkPath(seat, orch, 14, disc + 1)
      const line = look === 'working' ? flowingLink(ctx, `s${count}`, seat, orch, 14, disc + 1) : link(ctx, look, d)
      const hold = SHOT_MS + LINE_HOLD_MS
      style += `@keyframes ${name}l{0%,${Math.round((SHOT_MS / hold) * 100)}%{opacity:1}100%{opacity:0}}`
      body += `<g class="pk" style="animation:${name}l ${hold}ms linear both;${delayOf(start)}">${line}</g>`
      end = Math.max(end, start + hold)
    }
    style += `@keyframes ${name}{0%{transform:translate(0,0);opacity:0}10%{opacity:1}90%{opacity:1}100%{transform:translate(${to[0] - from[0]}px,${to[1] - from[1]}px);opacity:0}}`
    const dot = (r: number, opacity: number, lag: number) =>
      `<circle class="pk" cx="${from[0]}" cy="${from[1]}" r="${r}" fill="${color}" fill-opacity="${opacity}" style="animation:${name} ${SHOT_MS}ms ease-out both;${delayOf(start + lag)}${lag === 0 ? `;filter:drop-shadow(0 0 6px ${color})` : ''}"/>`
    body += [...TAIL].reverse().map(t => dot(t.r, t.opacity, t.lag)).join('') + dot(SHOT_R, 1, 0)
    end = Math.max(end, start + SHOT_MS + TAIL[TAIL.length - 1]!.lag)
    return start + SHOT_MS
  }
  const ring = (at: [number, number], color: string, r: number, when: number) => {
    body += `<circle class="rip" cx="${at[0]}" cy="${at[1]}" r="${r}" stroke="${color}" stroke-width="1.5" style="${delayOf(when)}"/>`
    end = Math.max(end, when + RING_MS)
  }
  for (const { event, start } of shotPlan(data, taskId)) {
    const from = seatOf(event.from)
    const to = seatOf(event.to)
    if (event.type === 'dispatch' && to) {
      ring(to, T.working, 14, leg(to, true, T.working, start, 'working'))
    } else if (event.type === 'report' && from) {
      ring(orch, T.review, disc, leg(from, false, T.review, start))
    } else if (event.type === 'handoff' && from && to) {
      ring(to, T.working, 14, leg(to, true, T.working, leg(from, false, T.working, start), 'working'))
    } else if (event.type === 'agent_done') {
      // An accept: from the agent itself, or several in one "Accepted: A, B" from the orchestrator.
      const names = from ? [event.from] : (/^Accepted: (.+)$/.exec(event.text)?.[1]?.split(',') ?? [])
      for (const name of names) {
        const seat = seatOf(name)
        if (seat) ring(seat, T.done, 14, leg(seat, true, T.done, start, 'done'))
      }
    } else if (event.type === 'needs_user' && from) {
      ring(orch, T.needs, disc, leg(from, false, T.needs, start))
    } else if (event.type === 'progress' && from) {
      // One soft pulse on the agent's node: no shot, it told no one.
      ring(from, alpha(T.working, 0.6), 14, start)
    }
  }
  return { body, style, end }
}

/** One agent card, 184 wide and `h` tall (the design's 104: 3 lines) at (x, y). */
/** What an idle card says when it has nothing of its own: under 40 characters either way. */
export const IDLE_LINE = { inTask: 'No part in this task', noTask: 'Waiting for a task' }

/**
 * A working agent's newest progress line since its status last changed (its own words, under the
 * task the orchestrator set), or '' when it has none.
 */
export const progressOf = (events: McEvent[], slot: Slot): string => {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!event || event.time < slot.startedAt) break
    if (event.type === 'progress' && event.from.toLowerCase() === slot.name.toLowerCase()) return event.text
  }
  return ''
}

/**
 * A card's task line: its task, or for an idle one what idle means here: under a finished or failed
 * task, what it did in it (`result`, MissionData.results), else no part.
 */
export const messageOf = (slot: Slot, look: Look, hasTask: boolean, result = ''): string =>
  look === 'idle' ? result || (hasTask && !slot.placeholder && slot.currentTask) || (hasTask ? IDLE_LINE.inTask : IDLE_LINE.noTask) : slot.currentTask

const card = (ctx: Ctx, slot: Slot, look: Look, x: number, y: number, h: number, hasTask: boolean, progressLine = '', result = ''): string => {
  const { T } = ctx
  const w = 184
  const id = `${ctx.id}-c${x}-${y}`
  let shell = ''
  if (look === 'working' || look === 'needs_user' || look === 'in_review') {
    // In review is lit like the others but has no glow (no more than Done, which has none).
    const color = look === 'working' ? T.working : look === 'in_review' ? T.review : T.needs
    const glow = look === 'working' ? ` style="filter:drop-shadow(0 0 9px ${alpha(T.working, T.glowCard)})"` : ''
    const breathe = look === 'needs_user' ? ` class="${m(ctx, 'm breathe')}" style="${phase(ctx, 2400)}"` : ''
    shell =
      `<defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.12"/><stop offset="1" stop-color="${color}" stop-opacity="0.02"/></linearGradient></defs>` +
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="12" fill="${T.surface}"${glow}/>` +
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="12" fill="url(#${id})"/>` +
      `<rect${breathe} x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="12" fill="none" stroke="${alpha(color, 0.45)}"/>`
  } else {
    shell = `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="12" fill="${T.surface}" stroke="${T.line}"/>`
  }
  const quiet = look === 'queued' || look === 'idle'
  const idle = look === 'idle'
  const ix = x + 13
  const top = y + 11
  const right = x + w - 13
  let row = avatar(T, slot.name, look, ix, top, ctx.motion)
  const nameMax = right - (ix + 38) - 60
  // Idle is the least prominent: its name in tertiary, below queued's secondary.
  const nameFill = idle ? T.tertiary : quiet ? T.secondary : T.text
  row += text(ix + 38, baseline(top + 6, 16, 13), fit(slot.name, nameMax, 13), { size: 13, fill: nameFill, weight: 500 })
  if (look === 'working' && ctx.offline) {
    // Offline: nothing claims to be active now; when it was last heard of instead.
    // Stacked in two short lines, as wide as NEEDS YOU, so the name keeps its room.
    const seen = { size: 9, fill: T.tertiary, face: 'mono' as const, weight: 500, tracking: 0.72, anchor: 'end' as const }
    row += text(right, baseline(top, 14, 9), 'LAST SEEN', seen) + text(right, baseline(top + 13, 14, 9), timeOfDay(ctx.clockAt), seen)
  } else if (look === 'working') {
    row += liveClock(ctx, `t${x}-${y}`, right, baseline(top + 6, 16, 11), ctx.clockAt - slot.startedAt, {
      size: 11,
      fill: T.ink.working,
      weight: 500,
      anchor: 'end',
    })
    row += liveBars(T, right - 5 * 6.6 - 6 - 12, top + 8, ctx.motion)
  } else {
    // No timer and no bars for in review: the agent is not working.
    const word = STATE_WORD[look]
    const color = { done: T.ink.done, queued: T.tertiary, needs_user: T.ink.needs, in_review: T.ink.review, idle: T.tertiary }[look]
    const waited = ctx.clockAt - slot.startedAt
    if (look === 'in_review' && waited > REVIEW_STALE_MS) {
      // Waiting on the orchestrator past two minutes: say how long, stacked so the name keeps its room.
      const o = { size: 9, fill: color, face: 'mono' as const, weight: 500, tracking: 0.72, anchor: 'end' as const }
      row += text(right, baseline(top, 14, 9), word, o) + text(right, baseline(top + 13, 14, 9), `${Math.floor(waited / 60_000)} MIN`, o)
    } else {
      row += text(right, baseline(top + 6, 16, 9), word, { size: 9, fill: color, face: 'mono', weight: 500, tracking: 0.72, anchor: 'end' })
    }
  }
  const message = messageOf(slot, look, hasTask, result)
  // As many 16px lines as the card's height leaves under its top row (3 at the design's 104), at
  // most 3 in all: the task text first; a working agent's own newest line under it, quieter.
  const lines = Math.max(1, Math.min(3, Math.floor((h - 56) / 16)))
  const extra = look === 'working' && progressLine && lines >= 2 ? progressLine : ''
  const taskLines = wrap(message, w - 26, 12, extra ? lines - 1 : lines)
  const ownLines = extra ? wrap(extra, w - 26, 12, lines - taskLines.length) : []
  const words =
    taskLines
      .map((line, index) => text(ix, baseline(top + 36 + index * 16, 16, 12), line, { size: 12, fill: quiet ? T.tertiary : T.secondary }))
      .join('') +
    ownLines
      .map((line, index) => text(ix, baseline(top + 36 + (taskLines.length + index) * 16, 16, 12), line, { size: 12, fill: T.tertiary }))
      .join('')
  // Queued is dimmed whole where its tokens say; idle by its colours alone, so its text keeps 4.5:1.
  const dim = look === 'queued' && T.queuedOpacity < 1 ? ` opacity="${T.queuedOpacity}"` : ''
  return `<g${dim}>${shell}${row}${words}</g>`
}

/**
 * The orchestrator's status under "ORCH": inside the disc where it fits (its width less 8px on each
 * side), at 7px with the design's 0.7 tracking, else 7px untracked, else 6.5px untracked; never
 * smaller and never clipped. Its words (model.ts ORCH_LABELS) always fit; a wider one would go on a
 * line under the dashed ring, at the design's 7px.
 */
export const orchRoomOf = (disc: number): number => disc * 2 - 16
export const ORCH_ROOM = orchRoomOf(ORCH_DISC_R)
export const ORCH_SIZES = [
  { size: 7, tracking: 0.7 },
  { size: 7, tracking: 0 },
  { size: 6.5, tracking: 0 },
]
/** A mono word's width at `size` with `tracking` px between its characters. */
export const orchWordWidth = (word: string, size: number, tracking: number): number => word.length * (size * 0.6 + tracking) - tracking
const orchStatusText = (T: Tokens, at: [number, number], word: string, needs: boolean, disc: number): string => {
  const fits = ORCH_SIZES.find(({ size, tracking }) => orchWordWidth(word, size, tracking) <= orchRoomOf(disc))
  const o = { fill: needs ? T.ink.needs : T.secondary, face: 'mono' as const, anchor: 'middle' as const }
  if (fits) return text(at[0], baseline(at[1] + 2, 10, fits.size), word, { ...o, size: fits.size, tracking: fits.tracking })
  return text(at[0], baseline(at[1] + Math.round(orchRingOf(disc)) + 2, 10, 7), word, { ...o, size: 7, tracking: 0.7 })
}

/** Legend type: items are 10px mono at 0.6 tracking, "AGENTS" at 1 (px per character). */
const LEGEND_CHAR = 6.6
const TITLE_CHAR = 7
/** An item's dot and the gap before its words; the gap between items. */
const LEGEND_DOT = 10
const LEGEND_GAP = 12
/** A second legend row sits this much lower; the agents area moves down by as much. */
export const LEGEND_ROW = 18

const LEGEND_ORDER: [string, Look][] = [
  ['ACTIVE', 'working'],
  ['IN REVIEW', 'in_review'],
  ['NEEDS YOU', 'needs_user'],
  ['DONE', 'done'],
  ['QUEUED', 'queued'],
  ['IDLE', 'idle'],
]

export type LegendEntry = { word: string; look: Look; count: number }
export type LegendLayout = { title: string; rows: LegendEntry[][]; titleWidth: number; rowWidths: number[]; room: number[] }

const entryWidth = (entry: LegendEntry) => `${entry.count} ${entry.word}`.length * LEGEND_CHAR + LEGEND_DOT
const rowWidth = (row: LegendEntry[]) => row.reduce((sum, entry) => sum + entryWidth(entry), 0) + LEGEND_GAP * Math.max(0, row.length - 1)

/**
 * The legend beside "AGENTS": every reported agent counted by how it is drawn (all idle with no
 * task; a seat no agent was reported for is idle too), in order ACTIVE, IN REVIEW, NEEDS YOU,
 * DONE, QUEUED, IDLE, each only when above zero except ACTIVE, which always shows. One row beside
 * "AGENTS" while it fits; the rest wraps, in order, onto a second row right-aligned under it. Never
 * shrunk or cut, and never over "AGENTS".
 */
export const legendOf = (data: MissionData, offline = false): LegendLayout => {
  const state = data.state
  const slots = slotsOf(state?.agents ?? [])
  const seated = slots.filter(slot => !slot.placeholder).length
  const unseated = (state?.agents.length ?? 0) - seated
  // Offline the counts are old news: say so in the label.
  const name = offline ? 'LAST KNOWN' : 'AGENTS'
  const title = unseated > 0 ? `${name} +${unseated}` : name
  const looks: Look[] = [
    ...(state?.agents ?? []).map(agent => (!state?.task ? 'idle' : agent.status)),
    ...slots.filter(slot => slot.placeholder).map((): Look => 'idle'),
  ]
  const entries = LEGEND_ORDER.map(([word, look]) => ({ word, look, count: looks.filter(each => each === look).length })).filter(
    entry => entry.word === 'ACTIVE' || entry.count > 0,
  )
  const titleWidth = title.length * TITLE_CHAR
  const room = [W - 14 - (14 + titleWidth + 16), W - 28]
  const first: LegendEntry[] = []
  for (const entry of entries) {
    if (first.length === entries.indexOf(entry) && rowWidth([...first, entry]) <= (room[0] ?? 0)) first.push(entry)
  }
  const rest = entries.slice(first.length)
  const rows = rest.length > 0 ? [first, rest] : [first]
  return { title, rows, titleWidth, rowWidths: rows.map(rowWidth), room }
}

/** The agents area's header height for `data`: one legend row or two. */
export const agentsHeadOf = (data: MissionData, now: number): number =>
  AGENTS_HEAD + (legendOf(data, offlineOf(data, now)).rows.length - 1) * LEGEND_ROW

/** Agents, 402 tall at the design's size: counts, the graph, the 2 x 2 cards. */
export const agentsSection = (data: MissionData, now: number, theme: ThemeMode, size: AgentsSize = DESIGN_AGENTS): Piece => {
  const state = data.state
  const slots = slotsOf(state?.agents ?? [])
  const looks = slots.map(slot => lookOf(state, slot))
  const G = size.graph
  const legend = legendOf(data, offlineOf(data, now))
  const H = AGENTS_HEAD + (legend.rows.length - 1) * LEGEND_ROW
  const height = agentsHeight(size, H)
  const SEATS = seatsFor(G)
  const ORCH = orchFor(G)
  const svg = doc(theme, W, height, T => {
    const ctx = ctxFor(data, now, 'ag', T)
    const tone: Record<Look, [string, string]> = {
      working: [T.working, T.ink.working],
      in_review: [T.review, T.ink.review],
      needs_user: [T.needs, T.ink.needs],
      done: [T.done, T.ink.done],
      queued: [T.queued, T.tertiary],
      idle: [T.idle, T.tertiary],
    }
    let head = label(14, 18, legend.title, T.tertiary)
    legend.rows.forEach((row, rowIndex) => {
      const top = 18 + rowIndex * LEGEND_ROW
      let cursor = W - 14
      for (const entry of [...row].reverse()) {
        const content = `${entry.count} ${entry.word}`
        const width = content.length * LEGEND_CHAR
        const [color, ink] = tone[entry.look]
        head += label(cursor, top, content, ink, { tracking: 0.6, anchor: 'end' }) + dot(cursor - width - 5 - 2.5, top + 6, 2.5, color)
        cursor -= width + LEGEND_DOT + LEGEND_GAP
      }
    })

    // The graph: 376 x G at (12, H), its grid every 47 across and 37 down.
    const [gx, gy] = [12, H]
    const rows = Array.from({ length: Math.max(0, Math.ceil(G / 37) - 1) }, (_, index) => (index + 1) * 37).filter(y => y < G)
    const grid =
      [47, 94, 141, 188, 235, 282, 329].map(x => `<path d="M${gx + x - 1} ${gy}V${gy + G}" stroke="${T.grid}"/>`).join('') +
      rows.map(y => `<path d="M${gx} ${gy + y - 1}H${gx + 376}" stroke="${T.grid}"/>`).join('')
    const orchAt: [number, number] = [gx + ORCH[0], gy + ORCH[1]]
    const circle = orchCircleFor(G)
    const links = SEATS.map(([sx, sy], index) => {
      const look = looks[index] ?? 'idle'
      const seat: [number, number] = [gx + sx, gy + sy]
      return look === 'working' ? flowingLink(ctx, String(index), seat, orchAt, 14, circle.disc + 1) : link(ctx, look, linkPath(seat, orchAt, 14, circle.disc + 1))
    }).join('')
    const orchStatus = orchestratorOf(state, now).status
    // The ring always turns, in every status and whether or not the pane is live (a paused task or a
    // quiet minute, as while the orchestrator waits on the person, stops the rest); only reduced
    // motion stops it (the `.m` rule).
    const ringClass = `m spin${orchStatus === 'dispatching' ? ' fast' : ''}`
    const ringStyle = phase(ctx, orchStatus === 'dispatching' ? 8000 : 24000)
    const nodes = SEATS.map(([sx, sy], index) => {
      const slot = slots[index]
      const look = looks[index] ?? 'idle'
      if (!slot) return ''
      const labelTop = nodeLabelTop(G, index)
      const lit = look === 'working' || look === 'needs_user' || look === 'in_review'
      return (
        avatar(T, slot.name, look, gx + sx - 14, gy + sy - 14, ctx.motion) +
        text(gx + sx, baseline(gy + labelTop, 12, 9), fit(slot.name.toUpperCase(), NODE_LABEL_MAX, 9, 'mono', 0.9), {
          size: 9,
          fill: lit ? T.text : look === 'idle' ? T.tertiary : T.secondary,
          face: 'mono',
          weight: 500,
          tracking: 0.9,
          anchor: 'middle',
        })
      )
    }).join('')
    const orch =
      orchestratorNode(T, orchAt[0], orchAt[1], ringClass, ringStyle, orchStatus === 'needs_user', circle.disc) +
      text(orchAt[0], baseline(orchAt[1] - 11, 12, 9), 'ORCH', { size: 9, fill: orchStatus === 'needs_user' ? T.strong : T.ink.orch, face: 'mono', weight: 500, tracking: 0.9, anchor: 'middle' }) +
      orchStatusText(T, orchAt, ORCH_LABELS[orchStatus], orchStatus === 'needs_user', circle.disc)
    // The one-shot packets and pulses are a drawing of their own over this one (agentsPackets), so a
    // new event does not redraw the agents.
    const graph =
      `<defs><clipPath id="${ctx.id}-graph"><rect x="${gx}" y="${gy}" width="376" height="${G}" rx="14"/></clipPath></defs>` +
      `<rect x="${gx + 0.5}" y="${gy + 0.5}" width="375" height="${G - 1}" rx="14" fill="${T.surface}" stroke="${T.line}"/>` +
      `<g clip-path="url(#${ctx.id}-graph)">${grid}${links}${orch}${nodes}</g>`
    const cards = slots
      .map((slot, index) => {
        const top = H + G + 8 + (index < 2 ? 0 : size.card + 8)
        return card(ctx, slot, looks[index] ?? 'idle', index % 2 === 0 ? 12 : 204, top, size.card, Boolean(state?.task), progressOf(data.events, slot), data.results?.[slot.name.toLowerCase()])
      })
      .join('')
    return { body: greyed(ctx, head + graph + cards), style: clockStyle([18]) }
  })
  const alt = slots.map((slot, index) => `${slot.name}: ${(looks[index] ?? 'idle').replace('_', ' ')}`).join(', ')
  return { key: 'agents', svg, height, width: W, alt: `Agents. ${alt}` }
}

/**
 * The shots and pulses for recent events, as a transparent drawing the size of the agents area, laid
 * over it; null when there are none still to play. Timed by the clock, so drawing it again while it
 * plays carries every shot on where it was (the pane keeps its source while only the delays differ).
 */
export const agentsPackets = (data: MissionData, now: number, theme: ThemeMode, size: AgentsSize = DESIGN_AGENTS): Piece | null => {
  if (data.fresh.length === 0) return null
  const state = data.state
  const slots = slotsOf(state?.agents ?? [])
  const G = size.graph
  const H = AGENTS_HEAD + (legendOf(data, offlineOf(data, now)).rows.length - 1) * LEGEND_ROW
  const height = agentsHeight(size, H)
  let shown = false
  const svg = doc(theme, W, height, T => {
    const ctx = ctxFor(data, now, 'pk', T)
    const [gx, gy] = [12, H]
    const shot = packets(ctx, data, slots, gx, gy, G, state?.task?.id)
    shown ||= shot.body !== '' && shot.end > now
    return {
      body: `<defs><clipPath id="${ctx.id}-graph"><rect x="${gx}" y="${gy}" width="376" height="${G}" rx="14"/></clipPath></defs><g clip-path="url(#${ctx.id}-graph)">${shot.body}</g>`,
      style: shot.style,
    }
  })
  return shown ? { key: 'agents-packets', svg, height, width: W, alt: 'Messages between the agents' } : null
}

// ---- loading ----------------------------------------------------------------------------------

/** Before the first read: the Overview's shapes, pulsing. */
export const skeleton = (now: number, theme: ThemeMode): Piece => {
  const svg = doc(theme, W, 579, T => {
    const ctx: Ctx = { now, motion: true, offline: false, id: `sk${T.name[0]}`, T, mode: 'loading', clockAt: now }
    const bar = (x: number, y: number, w: number, h: number, r = 4) =>
      `<rect class="m skel" style="${phase(ctx, 1400)}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${T.skeleton}"/>`
    const box = (x: number, y: number, w: number, h: number, r: number) =>
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${r}" fill="${T.surface}" stroke="${T.line}"/>`
    return {
      body:
        box(12, 0, 376, 175, 14) +
        bar(27, 15, 90, 10) +
        bar(27, 38, 300, 14) +
        bar(27, 60, 200, 14) +
        bar(27, 93, 346, 4, 2) +
        bar(27, 148, 260, 10) +
        box(12, 195, 376, 140, 14) +
        [0, 1, 2, 3]
          .map(index => {
            const x = index % 2 === 0 ? 12 : 204
            const y = index < 2 ? 343 : 455
            return (
              box(x, y, 184, 104, 12) +
              bar(x + 13, y + 11, 28, 28, 14) +
              bar(x + 51, y + 18, 70, 12) +
              bar(x + 13, y + 50, 150, 10) +
              bar(x + 13, y + 68, 110, 10)
            )
          })
          .join(''),
    }
  })
  return { key: 'skeleton', svg, height: 579, width: W, alt: 'Loading the team' }
}

// ---- the Activity view ------------------------------------------------------------------------

/** The task summary: title (13 / 19, two lines at most) and the compact bar. */
export const activitySummary = (data: MissionData, now: number, theme: ThemeMode): Piece => {
  const task = data.state?.task ?? null
  const lines = wrap(task ? task.title : 'Nothing is running', W - 32, 13, 2)
  const barTop = 16 + lines.length * 19 + 10
  const height = barTop + 3 + SECTION_GAP + 1
  const svg = doc(theme, W, height, T => {
    const ctx = ctxFor(data, now, 'as', T)
    const content =
      lines
        .map((line, index) => text(16, baseline(16 + index * 19, 19, 13), line, { size: 13, fill: task ? T.text : T.secondary, weight: 500 }))
        .join('') + progress(ctx, data.state, data.events, 16, barTop, W - 32, 3).bars
    return { body: hline(T, 0) + greyed(ctx, content) + hline(T, height - 1) }
  }, true)
  return { key: 'a-summary', svg, height, width: W, alt: task ? task.title : 'Nothing is running' }
}

/** The orchestrator's name as the events carry it. */
const isOrchestrator = (event: McEvent): boolean => event.from.trim().toLowerCase() === 'orchestrator'

const ROLES: ReadonlySet<string> = new Set(['orchestrator', 'explorer', 'worker', 'tester', 'security'])
const PERSON: ReadonlySet<string> = new Set(['user', 'owner', 'person'])
/** Who an event is from, for its colour (tokens.ts `actor`): the person, the orchestrator, a helper role, or another agent. */
export const actorOf = (from: string): Actor => {
  const id = from.trim().toLowerCase()
  if (PERSON.has(id)) return 'user'
  return ROLES.has(id) ? (id as Actor) : 'other'
}
/** An older event's dot: its sender's colour, dimmed. */
const OLDER_DOT = 0.55

/**
 * The timeline's items, newest first: one per event, except that consecutive progress lines from
 * one agent, each within a minute of the next, are one item under one name heading.
 */
export type TimelineItem = { from: string; events: McEvent[] }
const GROUP_MS = 60_000
export const timelineItems = (events: McEvent[]): TimelineItem[] => {
  const items: TimelineItem[] = []
  for (const event of [...events].reverse()) {
    const last = items[items.length - 1]
    const lastEvent = last?.events[last.events.length - 1]
    const groups =
      last &&
      lastEvent &&
      event.type === 'progress' &&
      lastEvent.type === 'progress' &&
      last.from.toLowerCase() === event.from.toLowerCase() &&
      lastEvent.time - event.time <= GROUP_MS
    if (groups) last.events.push(event)
    else items.push({ from: event.from, events: [event] })
  }
  return items
}

const TEXT_W = W - 16 - 77
/** One event's height in the list: with its name heading (the first of an item) or under one. */
const entryHeight = (lines: number, headed: boolean) => (headed ? 20 + 2 : 0) + Math.max(lines, 1) * 18 + (headed ? 0 : 4)

/**
 * The timeline: newest first, every event kept (40), the newest lit. Each sender's dot and name take
 * its colour (tokens.ts `actor`), an older event's dot dimmed; an agent's run of progress lines
 * shares one heading, each line with its time on the left. The orchestrator's lines are quieter.
 */
export const timeline = (data: MissionData, now: number, theme: ThemeMode): Piece => {
  const items = timelineItems(data.events)
  const count = data.events.length
  // Work for something other than the current task carries a quiet mark at the start of its line.
  const wrapped = items.map(item => item.events.map(event => wrap(event.side ? `Other task · ${event.text}` : event.text, TEXT_W, 12, 2)))
  const itemHeights = wrapped.map(lines => lines.reduce((sum, each, index) => sum + entryHeight(each.length, index === 0), 0) + 18)
  const height = Math.max(SECTION_GAP + 12 + 14 + (items.length === 0 ? 40 : itemHeights.reduce((sum, h) => sum + h, 0)), 120)
  const svg = doc(theme, W, height, T => {
    const ctx = ctxFor(data, now, 'tl', T)
    let y = SECTION_GAP
    let content =
      label(16, y, 'TODAY', T.tertiary) +
      label(W - 16, y, `${count} ${count === 1 ? 'EVENT' : 'EVENTS'} · NEWEST FIRST`, T.tertiary, {
        weight: 400,
        tracking: 0.6,
        anchor: 'end',
      })
    y += 12 + 14
    if (items.length === 0) content += text(77, baseline(y, 20, 12), 'No activity yet', { size: 12, fill: T.tertiary })
    items.forEach((item, itemIndex) => {
      const lines = wrapped[itemIndex] ?? []
      const top = y
      const quiet = item.events[0] ? isOrchestrator(item.events[0]) : false
      const color = T.actor[actorOf(item.from)]
      item.events.forEach((event, eventIndex) => {
        const newest = itemIndex === 0 && eventIndex === 0
        const headed = eventIndex === 0
        const eventLines = lines[eventIndex] ?? []
        const textTop = headed ? y + 22 : y
        content += text(16, baseline(headed ? y : y, headed ? 20 : 18, 10), timeOfDay(event.time), {
          size: 10,
          fill: newest ? T.ink.working : T.tertiary,
          face: 'mono',
        })
        const cy = headed ? y + 9.5 : y + 9
        // The dot and the name in the sender's colour; an older event's dot dimmed, the newest lit.
        if (newest) {
          content += `<circle cx="61.5" cy="${cy}" r="3.5" fill="${color}" style="filter:drop-shadow(0 0 3px ${alpha(color, T.glowDot)})"/>`
        } else {
          content += `<g opacity="${OLDER_DOT}">${dot(61.5, cy, headed ? 3.5 : 2.5, color)}</g>`
        }
        if (headed) {
          content += text(77, baseline(y, 20, 13), fit(nameOf(event), TEXT_W, 13), { size: 13, fill: color, weight: 500 })
        }
        eventLines.forEach((line, row) => {
          content += text(77, baseline(textTop + row * 18, 18, 12), line, { size: 12, fill: quiet ? T.tertiary : T.secondary })
        })
        y += entryHeight(eventLines.length, headed)
      })
      y += 18
      if (itemIndex < items.length - 1) content += `<path d="M61.5 ${top + 17}V${y + 2}" stroke="${T.line}"/>`
    })
    return { body: greyed(ctx, content) }
  }, true)
  return { key: 'a-timeline', svg, height, width: W, alt: `${count} events, newest first` }
}

// ---- whole views --------------------------------------------------------------------------------

/**
 * The Overview, top to bottom. `card` is the task card's parts: its top drawing, the native row's
 * dot, words and end, and its bottom; the hooks module sets them in a native bordered Box.
 */
export type OverviewParts = {
  header: Piece
  /** Over the agents area while an event's packets play: its own drawing, so the agents' stays. */
  packets: Piece | null
  /** Offline only: the line under the header saying the pane shows the last known state. */
  notice: Piece | null
  loading: Piece | null
  card: { top: Piece; row: Piece[]; cap: Piece; rowPx: number } | null
  after: Piece[]
  /** The px the drawings and the native row take, and what's left for the flexible gap. */
  used: number
  spare: number
}

/**
 * The room the Overview has, in px: the pane body's height and the native update row's (both
 * from the measured cell: the body is `bodyRows` cells, the row one). Absent, the design's 786.
 */
export type Fit = { height: number; rowPx: number }

/** The task card's height: its top drawing, the native row, its bottom and the 1px border each side. */
const cardHeight = (rowPx: number): number => CARD_TOP + rowPx + CARD_CAP

export const overview = (data: MissionData, now: number, theme: ThemeMode, fit: Fit = { height: 786, rowPx: 16 }): OverviewParts => {
  const head = header(data, now, theme)
  if (!data.loaded) {
    const loading = skeleton(now, theme)
    const used = head.height + loading.height
    return { header: head, packets: null, notice: null, loading, card: null, after: [], used, spare: fit.height - used }
  }
  const next = upNext(data, now, theme)
  // The notice's height comes out of the agents area, like everything that is not fixed.
  const notice = staleNotice(data, now, theme)
  const fixed = head.height + (notice ? notice.height : 0) + cardHeight(fit.rowPx) + (next ? next.height : 0)
  const size = sizeAgents(fit.height - fixed, agentsHeadOf(data, now))
  const agents = agentsSection(data, now, theme, size)
  const shots = agentsPackets(data, now, theme, size)
  return {
    header: head,
    packets: shots,
    notice,
    loading: null,
    card: {
      top: taskTop(data, now, theme),
      row: (() => {
        // The row as three bands: everything up to the chevron, the chevron (the press target),
        // and the 8px after it with the right border.
        // The words band changes with every event; the chevron and the end never do, so they
        // are drawings of their own (a slice of the whole row would carry the whole row's source).
        const whole = updateRowPiece(data, now, theme, fit.rowPx)
        const end = ROW_CHEVRON.x + ROW_CHEVRON.width
        const still = updateRowPiece(EMPTY_ROW, now, theme, fit.rowPx, offlineOf(data, now))
        return [
          slice(whole, 0, ROW_CHEVRON.x, 'update-row', whole.alt),
          slice(still, ROW_CHEVRON.x, ROW_CHEVRON.width, 'update-chevron', 'Open the activity'),
          slice(still, end, CARD_W - end, 'update-end', 'End of the latest update'),
        ]
      })(),
      cap: taskCap(theme),
      rowPx: fit.rowPx,
    },
    after: [...(next ? [next] : []), agents],
    used: fixed + agents.height,
    spare: size.spare,
  }
}

/**
 * While the cell is measured (once a session): one drawing exactly MEASURE_PX tall, the header and
 * the loading shapes at its top, so the engine's row count of it gives the cell's height.
 */
export const MEASURE_PX = 4000
export const measuring = (now: number, theme: ThemeMode): Piece => {
  const head = header({ ...EMPTY_LOADING }, now, theme)
  const shapes = skeleton(now, theme)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${MEASURE_PX}" viewBox="0 0 ${W} ${MEASURE_PX}" fill="none">` +
    `<svg x="0" y="0" width="${W}" height="${head.height}">${head.svg}</svg>` +
    `<svg x="0" y="${head.height}" width="${W}" height="${shapes.height}">${shapes.svg}</svg></svg>`
  return { key: 'measuring', svg, height: MEASURE_PX, width: W, alt: 'Loading the team' }
}
const EMPTY_LOADING: MissionData = { loaded: false, state: null, events: [], eventCount: 0, fresh: [], readAt: 0, offline: false }

/** The Activity view's drawings below its native header row. */
export const activity = (data: MissionData, now: number, theme: ThemeMode): Piece[] => [
  activitySummary(data, now, theme),
  timeline(data, now, theme),
]

/** For a native stand-in that should look like the drawn text. */