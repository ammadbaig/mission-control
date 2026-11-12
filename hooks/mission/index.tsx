import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { MissionTheme, MissionView } from '../../types'
import { SECTION, SECTION_ID, TOOL_DESCRIPTION, TOOL_FULL_NAME, TOOL_NAME, TOOL_SCHEMA } from './contract'
import { activity, BACK_SQUARE, backPiece, MEASURE_PX, measuring, modeOf, overview, pill, SHOT_MS, shotPlan, slice, type Piece } from './draw'
import { addHolds, heldAgents, type Hold } from './hold'
import { clockKeyOf, EMPTY_DATA, KEEP_EVENTS, isOffline, PART_TYPES, parseState, readNewLines, resultsOf, type McAgent, type McEvent, type McState, type MissionData } from './model'
import { GHOST_MS, settle, shown as asShown, steady, type Shown } from './swap'
import { activityLines, overviewLines, type Line, type Tone } from './term'
import { TOKENS } from './tokens'
import { autoCommand, isHelper, knownOrchestrator, loadAuto, markOrchestrating, notePanel, openTurn, startWatch, TAIL_BYTES, tailOf, watchCall } from './auto'
import { clearFinished, pathsOf, report, say, serially, whenWritten } from './io'
import { endedTurn, MAX_UPDATES, stateText, type Report } from './writer'
import { turnOf } from './transcript'

/**
 * Mission Control: the orchestrator's team as a pane. The data is what the orchestrator reports
 * through the `report` tool (or cli/mc.py): state.json and events.jsonl in the data folder; the
 * drawings are pure functions in draw.ts. Nothing paints a background: the pane's own shows
 * through, so the pane takes Claude's theme.
 */
const PANE = 'mission-control'
const TITLE = 'Mission Control'

const mission = atom({ plugin: 'mission-control', key: 'mission' } as const, EMPTY_DATA, { shape: 'mission-1' })
const view = atom({ plugin: 'mission-control', key: 'missionView' } as const, 'overview' as MissionView)
/** `auto` follows the app (the drawings' `prefers-color-scheme`); `/mission light|dark` pins one. */
const themeSetting = atom({ plugin: 'mission-control', key: 'missionTheme' } as const, 'auto' as MissionTheme)
/**
 * The pane's cell height in px (one `lh` of its body), measured once a session: 0 until then.
 * The desktop gives a pane its height as `bodyRows` cells; this turns that into pixels.
 */
const cellPx = atom({ plugin: 'mission-control', key: 'missionCell' } as const, 0)
/** The terminal's text pane: `auto` picks ASCII glyphs where the terminal cannot draw the others. */
const asciiSetting = atom({ plugin: 'mission-control', key: 'missionAscii' } as const, 'auto' as 'auto' | 'on' | 'off')
/** The second the terminal's timers show: written once a second while a task runs, read only by the text pane. */
const termSecond = atom({ plugin: 'mission-control', key: 'missionSecond' } as const, 0)
/** Whether this terminal looks unable to draw the block and arrow glyphs (no UTF-8 locale, a bare console). */
let plainTerminal = false
/**
 * The pane's width and height in px, from its size in cells. Two numbers, as a cell is not square:
 * - COLUMN_PX, one column's width, sets the scale: min(1, bodyColumns x COLUMN_PX / 400). Measured on
 *   the desktop app at its default text size, where the panel then fills the pane's width.
 * - ROW_PX, one row's height, sets the Overview's height budget (bodyRows x ROW_PX). The desktop's
 *   row is a little under 21px (a 39-row pane cut its last cards at 21); slightly short is
 *   chosen over slightly tall, so no card ever falls below the pane. `/mission measure` measures it,
 *   kept in `.panel.json`.
 */
const COLUMN_PX = 10.68
const ROW_PX = 20.3
/** Px kept back from the Overview's budget (see the render). */
const SAFETY = 12
/** While this session's task runs, it marks the state as fresh this often (the LIVE pill). */
const HEARTBEAT_MS = 20_000

type Stamp = { size: number; mtimeMs: number } | null

/** The file's size and change time, or `null` when it isn't there. */
async function stampOf($: EngineInterface, path: string): Promise<Stamp> {
  try {
    const stat = await $.fs.stat(path)
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}


/**
 * Mission Control's part of session.start: its command, the reader, the heartbeat, and the pane
 * opened where it can draw. Once a second the reader stats both files and reads only what
 * changed: state.json whole (a bad read keeps the last good state), events.jsonl from where it
 * left off (complete lines only; a log that shrank, as rotation leaves it, is read afresh). It
 * writes the pane's state only when something changed, or when the feed goes offline or comes
 * back.
 */
export async function startMission($: EngineInterface): Promise<void> {
  await loadAuto($).catch(() => undefined)
  startWatch($)
  await $.command.register({
    name: 'mission',
    description: 'Open Mission Control: what the team is doing now',
    argumentHint: '[light|dark|auto|measure] | ascii on|off|auto | auto on|off | agents [role=pattern] | role <role>|none',
  })
  const surfaces: readonly string[] = await $.session.surfaces().catch(() => [])
  if (surfaces.includes('desktop')) void $.ui.open({ id: PANE, title: TITLE })
  const onTerminal = surfaces.includes('terminal')
  plainTerminal = await cannotDrawGlyphs($)
  const kept = await $.store.get('ascii').catch(() => undefined)
  if (kept === 'on' || kept === 'off') await update($, asciiSetting, () => kept)

  const { state: STATE_FILE, events: EVENTS_FILE } = await pathsOf($)
  // No home folder: nothing to read or write; the pane says so in one line.
  homeMissing = STATE_FILE === ''
  if (homeMissing) return
  let loaded = false
  let state: McState | null = null
  let stateStamp: Stamp = null
  let logStamp: Stamp = null
  let logOffset = 0
  let events: McEvent[] = []
  let eventCount = 0
  let offline = true
  let lastClockKey = ''
  /** Events read since the pane opened, with when: their shots play by these times (the newest few seconds). */
  let recent: { event: McEvent; at: number }[] = []
  const SHOTS_KEPT_MS = 8000
  /**
   * The landing hold (hold.ts): agents with a shot on its way keep their last drawn look until it
   * lands. A drawing that changed appears GHOST_MS after it is drawn (swap.ts), so each switch is
   * drawn GHOST_MS before its landing, and lands with the shot; a timer draws it then.
   */
  let holds = new Map<string, Hold>()
  let lastShown = new Map<string, McAgent>()
  let holdKey = ''
  let holdTimer: Timer | null = null
  /**
   * Each recent task's own part events (dispatch, report, progress, accept), beyond the KEEP_EVENTS
   * the list keeps, so a long task's early parts still count when it ends. The newest TASKS_KEPT tasks.
   */
  const partsByTask = new Map<string, McEvent[]>()
  const TASKS_KEPT = 4
  const PARTS_KEPT = 400
  const noteParts = (added: McEvent[]) => {
    for (const event of added) {
      if (!event.taskId || event.side || !PART_TYPES.has(event.type)) continue
      const list = partsByTask.get(event.taskId) ?? []
      list.push(event)
      partsByTask.delete(event.taskId)
      partsByTask.set(event.taskId, list.slice(-PARTS_KEPT))
      for (const old of [...partsByTask.keys()].slice(0, Math.max(0, partsByTask.size - TASKS_KEPT))) partsByTask.delete(old)
    }
  }
  /** The orchestrator's turn transcript as last read: whether it shows that turn ended. */
  let turnRead: { path: string; turn: number; mtime: number; ended: boolean } | null = null
  let turnEnded = false

  /**
   * Whether the orchestrator's stored turn has in fact ended, from its own transcript (transcript.ts,
   * the rule for helpers): an end written after the turn began (an answer, the person's interrupt).
   * Read again only when the file changes. False with no turn, or no transcript to read.
   */
  const endedFromLog = async (current: McState | null): Promise<boolean> => {
    const orch = current?.orchestrator
    if (orch?.turn === undefined || !orch.turnLog) return false
    const stat = await $.fs.stat(orch.turnLog).catch(() => null)
    if (!stat) return false
    if (turnRead && turnRead.path === orch.turnLog && turnRead.turn === orch.turn && turnRead.mtime === stat.mtimeMs) return turnRead.ended
    const turn = turnOf(await tailOf($, orch.turnLog, TAIL_BYTES).catch(() => ''))
    const ended = turn.state === 'ended' && turn.endedAt >= orch.turn
    turnRead = { path: orch.turnLog, turn: orch.turn, mtime: stat.mtimeMs, ended }
    return ended
  }

  const tick = async () => {
    const now = await $.clock.now()
    let changed = !loaded
    let justRead: McEvent[] = []

    const nextState = await stampOf($, STATE_FILE)
    if (nextState && (!stateStamp || nextState.size !== stateStamp.size || nextState.mtimeMs !== stateStamp.mtimeMs)) {
      try {
        const parsed = parseState(await $.fs.read(STATE_FILE))
        if (parsed) {
          state = parsed
          stateStamp = nextState
          changed = true
        }
      } catch {
        // Mid-write or gone: keep the last good state and try again next second.
      }
    }

    const nextLog = await stampOf($, EVENTS_FILE)
    if (!nextLog) {
      if (logStamp) {
        logStamp = null
        logOffset = 0
        events = []
        changed = true
      }
    } else if (!logStamp || nextLog.size !== logStamp.size || nextLog.mtimeMs !== logStamp.mtimeMs) {
      try {
        const textOfLog = await $.fs.read(EVENTS_FILE)
        // Rotated (the newest lines kept) or rewritten: read it afresh, no packets.
        const restarted = (logStamp !== null && nextLog.size < logStamp.size) || textOfLog.length < logOffset
        if (restarted) {
          logOffset = 0
          events = []
          partsByTask.clear()
          recent = []
          changed = true
        }
        const { events: added, next } = readNewLines(textOfLog, logOffset)
        logOffset = next
        logStamp = nextLog
        noteParts(added)
        if (added.length > 0) {
          events = [...events, ...added].slice(-KEEP_EVENTS)
          eventCount += added.length
          // Only events new since the pane was first drawn: none replay on opening or after a rewrite.
          if (loaded && !restarted) {
            recent.push(...added.map(event => ({ event, at: now })))
            justRead = added
          }
          changed = true
        }
      } catch {
        // Try again next second.
      }
    }

    // The orchestrator's turn ended however it ended (no hook needed): drawn as ended.
    const ended = await endedFromLog(state).catch(() => false)
    if (ended !== turnEnded) {
      turnEnded = ended
      changed = true
    }
    const shown = ended && state ? endedTurn(state, now) : state
    // Time alone can change the pane: a long review's minutes, the orchestrator's own status lapsing.
    const clockKey = clockKeyOf(shown, now)
    if (clockKey !== lastClockKey) {
      lastClockKey = clockKey
      changed = true
    }
    // Any write to either file is a sign of life, not only a state write.
    const aliveAt = Math.max(stateStamp?.mtimeMs ?? 0, logStamp?.mtimeMs ?? 0)
    const quiet = isOffline(state, now, aliveAt)
    if (quiet !== offline) {
      offline = quiet
      changed = true
    }
    // The terminal's timers are text: while a task runs, they move once a second.
    if (onTerminal && state?.task?.status === 'running') await update($, termSecond, () => Math.floor(now / 1000))
    // A finished or failed task: what each agent did in it, for its idle card.
    const task = shown?.task
    const closed = task && (task.status === 'done' || task.status === 'failed')
    const results = closed ? resultsOf(partsByTask.get(task.id) ?? [], task.id) : undefined
    recent = recent.filter(item => now - item.at < SHOTS_KEPT_MS)
    const fresh = recent.map(item => item.event)
    const freshAt = recent.map(item => item.at)
    // With no task the pane shows no events: none of a finished task's lines once it is cleared.
    const real: MissionData = { loaded: true, state: shown, events: shown?.task ? events : [], eventCount: shown?.task ? eventCount : 0, fresh, freshAt, readAt: now, offline, aliveAt, ...(results ? { results } : {}) }
    // New shots (only where they play: a live pane) hold their agents' looks until they land.
    if (justRead.length > 0 && modeOf(real, now) === 'live') {
      const landed = shotPlan(real, shown?.task?.id)
        .filter(item => justRead.includes(item.event))
        .map(item => ({ event: item.event, at: item.start + SHOT_MS }))
      holds = addHolds(holds, landed, lastShown)
    }
    const held = shown ? heldAgents(shown.agents, holds, now, GHOST_MS) : { agents: [], holds: new Map<string, Hold>(), nextAt: null }
    holds = held.holds
    const drawnState = shown ? { ...shown, agents: held.agents } : shown
    lastShown = new Map(held.agents.map(agent => [agent.name.toLowerCase(), agent]))
    const key = held.agents.map(agent => `${agent.name}:${agent.status}:${agent.startedAt}`).join('|')
    if (key !== holdKey) {
      holdKey = key
      changed = true
    }
    holdTimer?.cancel()
    holdTimer = held.nextAt === null ? null : $.clock.after(Math.max(1, held.nextAt - now), safeTick)
    if (!changed) return
    loaded = true
    const data: MissionData = { ...real, state: drawnState }
    await update($, mission, () => data)
  }

  // A read that fails (the session ending under it, say) is dropped: the next second tries again.
  const safeTick = () => void tick().catch(() => undefined)
  // After this session writes: read now, and keep the task LIVE while it is this session's.
  whenWritten(state => {
    if (state) setOwnsTask($, state.task?.status === 'running')
    safeTick()
  })
  safeTick()
  // One reader per environment: a second session.start replaces the first's timer.
  reader?.cancel()
  reader = $.clock.every(1000, safeTick)
  // The cell measured before (in any session) stands, so the pane is drawn at its size at once.
  // The cell set or measured before (in any session) stands; else the default. Nothing is measured
  // by itself: the panel is drawn at once and stays drawn.
  const stored = await storedCell($).catch(() => null)
  if (stored) {
    cellSource = stored.source
    await update($, cellPx, () => stored.cell)
  }
}

/**
 * The timers this module starts. The reader runs for the session; the heartbeat only while this
 * session owns a running task, and is cancelled when the task ends or the session does. On a
 * reload the engine drops a module's timers itself, so none outlive the code that set them.
 */
let reader: Timer | null = null
let beat: Timer | null = null

/** Starts or stops this session's heartbeat as it comes to own a running task or stops owning it. */
function setOwnsTask($: EngineInterface, owns: boolean): void {
  ownsTask = owns
  if (owns && !beat) beat = $.clock.every(HEARTBEAT_MS, () => void heartbeat($))
  if (!owns && beat) {
    beat.cancel()
    beat = null
  }
}

/** The session ended (or was cleared): it no longer keeps a task LIVE. */
export function endMission($: EngineInterface): void {
  setOwnsTask($, false)
}

/**
 * `/mission measure` only: while `measuringNow`, the pane draws one drawing MEASURE_PX tall; a
 * scroll of it raises `ui.scroll`, whose `contentRows` is that height in cells (the hook below
 * turns it into px). Tried every 1.5s, up to 10 times; with no answer, the cell in use stays and
 * the panel comes back. Never started by itself: not at start, not on a resize.
 */
async function measureCell($: EngineInterface, tries = 0): Promise<void> {
  if (!measuringNow) return
  if (tries >= 10) {
    measuringNow = false
    await update($, swapTick, n => n + 1)
    return
  }
  await $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
  $.clock.after(1500, () => void measureCell($, tries + 1).catch(() => undefined))
}

/** Bumped when a replaced drawing's time is up, so the pane redraws and lifts it. */
const swapTick = atom({ plugin: 'mission-control', key: 'missionSwap' } as const, 0)
/** The latest lift already set: one at or after a ghost's end lifts it too. */
let liftAt = 0
/**
 * A replaced drawing shown until `until` (swap.ts): a redraw then lifts it. Each ghost on screen
 * gets its own lift unless one at or after its end is already set; one lift for every ghost would
 * fire for the first and leave a later one standing until some unrelated draw.
 */
function liftGhostAt($: EngineInterface, until: number, now: number): void {
  if (liftAt >= until && liftAt > now) return
  liftAt = until
  $.clock.after(Math.max(1, until - now + 20), () => void update($, swapTick, n => n + 1).catch(() => undefined))
}

/** The lines a pane body could plausibly be drawn in: a measurement outside this is ignored. */
const CELL_RANGE = [12, 32]
const inRange = (cell: number): boolean => cell >= (CELL_RANGE[0] ?? 12) && cell <= (CELL_RANGE[1] ?? 32)

/** `/mission measure` is running: the pane shows the measuring drawing until it answers or gives up. */
let measuringNow = false
/** Where the cell in use came from: measured, or the default. */
type CellSource = 'measured' | 'default'
let cellSource: CellSource = 'default'
/** The measured cell, kept beside state.json so every session draws at that size at once. */
const PANEL_FILE = '.panel.json'

/** The cell measured before; null when none was (or the file is not one). */
async function storedCell($: EngineInterface): Promise<{ cell: number; source: CellSource } | null> {
  const { dir } = await pathsOf($)
  if (!dir) return null
  const raw = await $.fs.read(`${dir}/${PANEL_FILE}`).catch(() => '')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const cell = 'cell' in value ? Number(value.cell) : 0
  return Number.isFinite(cell) && inRange(cell) ? { cell, source: 'measured' } : null
}

/** Keeps a measured cell (never the default). */
async function keepCell($: EngineInterface, cell: number): Promise<void> {
  const { dir } = await pathsOf($)
  if (!dir || !inRange(cell)) return
  await $.fs.write(`${dir}/${PANEL_FILE}`, `${JSON.stringify({ cell, source: 'measured', at: await $.clock.now() })}\n`)
}

/** The last numbers written to the debug file, so it is written only on a change. */
let panelNoted = ''

// ---- the writer (io.ts) -------------------------------------------------------------------------

/**
 * Whether the terminal looks unable to draw the glyphs: a locale that is not UTF-8 (LC_ALL, else
 * LC_CTYPE, else LANG), or a bare console (TERM linux or dumb). Where nothing says, they are drawn.
 */
async function cannotDrawGlyphs($: EngineInterface): Promise<boolean> {
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_CTYPE')) || (await $.env.get('LANG')) || ''
  const term = (await $.env.get('TERM')) || ''
  return (locale !== '' && !/utf-?8/i.test(locale)) || term === 'linux' || term === 'dumb'
}

/** Each tone of the text pane as the terminal's theme keys: every state is also a word, so plain monochrome reads too. */
const TONE_PROPS: Record<Tone, { color?: string; dimColor?: boolean; bold?: boolean }> = {
  text: { color: 'text' },
  strong: { color: 'text', bold: true },
  dim: { dimColor: true },
  working: { color: 'suggestion', bold: true },
  done: { color: 'success' },
  review: { color: 'merged' },
  needs: { color: 'warning', bold: true },
  failed: { color: 'error' },
  paused: { color: 'inactive', bold: true },
}

/** No home folder was found: the pane shows a one-line notice and nothing is read or written. */
let homeMissing = false

/** Whether this session reported the task that is running (and so keeps it LIVE). */
let ownsTask = false

/** While this session's task runs, marks the state fresh so the pane stays LIVE. */
async function heartbeat($: EngineInterface): Promise<void> {
  if (!ownsTask) return
  await serially(async () => {
    const { state: STATE_FILE } = await pathsOf($)
    const raw = await $.fs.read(STATE_FILE).catch(() => '')
    const state = parseState(raw)
    if (!state || state.task?.status !== 'running') {
      setOwnsTask($, false)
      return
    }
    await $.fs.write(STATE_FILE, stateText({ ...state, lastUpdated: await $.clock.now() }))
  }).catch(() => undefined)
}

/** The `report` tool's answer: the model reads `result`, or `deny` as an error. */
async function answerReport($: EngineInterface, updates: unknown, as: unknown): Promise<{ result: string } | { deny: string }> {
  if (!Array.isArray(updates) || updates.length === 0) return { deny: 'report needs `updates`: a list of at least one update' }
  const valid = updates.filter((item): item is Report => typeof item === 'object' && item !== null && typeof (item as Report).do === 'string')
  if (valid.length !== updates.length) return { deny: 'every update needs `do`, such as "task.start"' }
  if (updates.length > MAX_UPDATES) return { deny: `at most ${MAX_UPDATES} updates per call; nothing was written` }
  // A helper (`as` set) may only add lines about its own work.
  const helper = as !== undefined && as !== null && as !== ''
  if (helper && valid.some(item => item.do !== 'say')) {
    return { deny: 'a helper may only add its own lines (do: "say"); the task, plan, queue and statuses are the orchestrator\'s. Nothing was written.' }
  }
  // The orchestrator's own writes mark this session as the one the turn-end guard watches.
  if (!helper) await markOrchestrating($).catch(() => undefined)
  // Its turn is open before this report applies, so a task.done in it shows DONE, not WORKING.
  if (!helper) await openTurn($).catch(() => undefined)
  const { applied, error, notes } = helper ? await say($, as, valid) : await report($, valid)
  const also = notes.length > 0 ? ` Note: ${notes.join('; ')}.` : ''
  if (error !== undefined) {
    return {
      deny: applied > 0 ? `Reported ${applied} of ${updates.length}; ${error}. Nothing after it was written.${also}` : `${error}. Nothing was written.${also}`,
    }
  }
  return { result: `Reported ${applied} update${applied === 1 ? '' : 's'} to Mission Control.${also}` }
}

/** Registers the `report` tool; the engine takes it once the session is bound. */
export async function registerTool($: EngineInterface): Promise<void> {
  await $.tool.register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false })
}

export const registerMission: Register = on => {
  // The contract, in every session's system prompt (after the engine's own sections).
  on('prompt.compose', async (_$, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: SECTION_ID, text: SECTION, scope: 'session' as const }] }
  })

  // The tool is answered here, so it never reaches a permission prompt: it only writes the
  // plugin's own two files. No matcher (a name the tool tables don't list): compared by name.
  on('tool.call', async ($, e, next) => {
    if (String(e.tool) !== TOOL_FULL_NAME) return watchCall($, e, next)
    const input = e as unknown as { updates?: unknown; as?: unknown }
    return answerReport($, input.updates, input.as)
  }).catch((_$, e, next) =>
    next.called || String(e.tool) !== TOOL_FULL_NAME ? next(e) : { deny: 'Mission Control could not write the report.' },
  )

  // contentRows = ceil((MEASURE_PX - 1) / cell), so the cell is at least (MEASURE_PX - 1) /
  // contentRows; that lower bound is kept, so the layout is never too tall.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    // Only while /mission measure is drawing the measuring drawing: any other scroll is the person's.
    if (measuringNow && e.contentRows > 1) {
      const measured = Math.floor(((MEASURE_PX - 1) / e.contentRows) * 100) / 100
      if (inRange(measured)) {
        measuringNow = false
        cellSource = 'measured'
        await update($, cellPx, () => measured)
        await keepCell($, measured).catch(() => undefined)
        void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
      }
    }
    return next(e)
  }).catch(() => ({}))

  on('command.run', { command: 'mission' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const automatic = await autoCommand($, [(words[0] ?? '').toLowerCase(), ...words.slice(1)])
    if (automatic) return { text: automatic }
    const asked = e.args.trim().toLowerCase()
    if (words[0]?.toLowerCase() === 'ascii') {
      const want = (words[1] ?? '').toLowerCase()
      if (want !== 'on' && want !== 'off' && want !== 'auto') return { text: 'Use /mission ascii on, off or auto.' }
      await update($, asciiSetting, () => want)
      await $.store.set('ascii', want)
      return { text: `Mission Control in the terminal: ${want === 'auto' ? `ASCII when the terminal cannot draw the glyphs (${plainTerminal ? 'it cannot' : 'it can'})` : `ASCII ${want}`}.` }
    }
    if (asked === 'light' || asked === 'dark' || asked === 'auto') {
      await update($, themeSetting, () => asked as MissionTheme)
    }
    // A session that is not a helper opening the pane is the orchestrator. A conversation new to the
    // plugin first clears a finished task, so it starts on the empty state; the check comes before the
    // mark, which would make it known. No turn is opened: a slash command is not a turn.
    if (!(await isHelper($).catch(() => true))) {
      if (!asked && !(await knownOrchestrator($).catch(() => true))) await clearFinished($).catch(() => false)
      await markOrchestrating($).catch(() => undefined)
    }
    await $.ui.open({ id: PANE, title: TITLE })
    // From the top: the terminal follows a tall pane's end otherwise.
    void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
    if (asked === 'measure') {
      // Asked for: the measuring drawing for a moment, then the panel at the measured size.
      measuringNow = true
      await update($, swapTick, n => n + 1)
      void measureCell($).catch(() => undefined)
    }
    return { text: asked ? `Mission Control opened (${asked}).` : 'Mission Control opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The terminal draws no Svg (its table may still answer `'Svg' in`): say where it draws.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const data = await read($, mission)
    const shown = await read($, view)
    const theme = await read($, themeSetting)
    const cell = await read($, cellPx)
    // Read so a lifted ghost redraws the pane (see liftGhostAt).
    await read($, swapTick)
    const now = await $.clock.now()
    const bodyRows = Math.max(1, e.props.scroll.bodyRows)

    if (homeMissing) {
      return (
        <Box padding="md">
          <Text dimColor>Mission Control found no home folder (HOME or USERPROFILE), so it reads and writes nothing. Set MC_DIR to choose one.</Text>
        </Box>
      )
    }

    if (!Svg) {
      // The terminal: the same data and rules as text (term.ts), with real buttons and hotkeys.
      await read($, termSecond)
      const ascii = await read($, asciiSetting)
      // One row is the button's.
      const options = { columns: Math.max(10, e.props.bodyColumns), rows: bodyRows - 1, ascii: ascii === 'on' || (ascii === 'auto' && plainTerminal) }
      const lines = shown === 'activity' ? activityLines(data, options) : overviewLines(data, now, options)
      const lineOf = (line: Line) => (
        <Box key={line.key} flexDirection="row">
          {line.segs.map((each, index) => (
            <Text key={`${line.key}-${index}`} wrap="truncate-end" {...TONE_PROPS[each.tone]}>
              {each.text}
            </Text>
          ))}
        </Box>
      )
      const [first, ...rest] = lines
      const button =
        shown === 'activity' ? (
          <Button key="back" hotkey="b" onPress={() => update($, view, () => 'overview' as MissionView)}>
            Back
          </Button>
        ) : (
          <Button key="activity" hotkey="a" onPress={() => update($, view, () => 'activity' as MissionView)}>
            Activity
          </Button>
        )
      return (
        <Box flexDirection="column">
          {[...(first ? [lineOf(first)] : []), <Box key="buttons" flexDirection="row">{button}</Box>, ...rest.map(lineOf)]}
        </Box>
      )
    }

    /**
     * The drawings' scale. Each is an iframe the app sizes to `width` x `height` px, but no wider
     * than its container (max-width 100%) at the same height, and its picture then fits inside,
     * letterboxed: in a pane narrower than 400px that left blank bands above and below every
     * drawing (the Activity view's 250px gap) and steps at the card's edges. So in a narrow pane
     * every drawing is scaled down whole, width and height alike, to the column it has: the body's
     * width is `bodyColumns` cells of COLUMN_PX each.
     */
    // The width from the columns, the height from the rows (a row set or measured, else ROW_PX): the
    // panel is always drawn, at once, and a resize only redraws it at the new size.
    const row = cell || ROW_PX
    const scale = Math.min(1, (e.props.bodyColumns * COLUMN_PX) / 400)
    const budget = Math.floor(bodyRows * row) - SAFETY
    const source: CellSource = cell ? cellSource : 'default'
    const noted = `${e.props.bodyColumns}|${bodyRows}|${row}|${source}|${scale}`
    if (noted !== panelNoted) {
      panelNoted = noted
      void notePanel($, { bodyColumns: e.props.bodyColumns, bodyRows, columnPx: COLUMN_PX, rowPx: row, rowSource: source, scale: Math.round(scale * 1000) / 1000, budget }).catch(() => undefined)
    }
    // An `alt` must never be empty, or the app drops the drawing.
    const svgOf = (picture: Shown) => (
      <Svg isInteractive source={picture.svg} alt={picture.alt} width={picture.width * scale} height={picture.height * scale} />
    )
    /**
     * A drawing in its slot (see swap.ts): its source kept while only its delays change, so the app
     * keeps its iframe. When it has changed, only one of the two is ever shown, never both (the
     * drawings have no background, so two on top of each other read as one double image): the one it
     * replaces stays, alone, in the slot's flow, while the new one loads hidden (display none) beside
     * it; after GHOST_MS a redraw drops the old one and shows the new one, already loaded, in one step:
     * no overlap and no blank frame. Both are always one Box deep in the slot, so the morph keeps the
     * new one's iframe when it is shown.
     */
    const draw = (piece: Piece) => {
      const { current, ghost } = settle(piece.key, asShown(piece), now)
      if (ghost) liftGhostAt($, ghost.until, now)
      if (!ghost) {
        return (
          <Box flexDirection="column" overflow="hidden">
            {[<Box flexDirection="column">{svgOf(current)}</Box>]}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" overflow="hidden">
          {[
            <Box position="absolute" top={0} left={0} display="none">
              {svgOf(current)}
            </Box>,
            <Box flexDirection="column">{svgOf(ghost)}</Box>,
          ]}
        </Box>
      )
    }
    // Native colours: in `auto` the app's own theme keys; pinned, the token set's.
    const pinned = theme === 'auto' ? null : TOKENS[theme]
    const strong = pinned ? { color: pinned.text } : { color: 'text' }
    const quieter = pinned ? { color: pinned.tertiary } : { dimColor: true }

    /**
     * A press target over a small drawing (the row's chevron, Back's square): the drawing shows
     * everything; over it lies a Box as large as it (position absolute, every edge 0: the app makes
     * the holder relative) with one plain Button centred in it. From the app's renderer:
     * - the app paints a Button's label, in its text colour (child Texts are flattened into it),
     *   so the label is blank by content: one braille blank (U+2800, not whitespace, so never
     *   trimmed; about 9px). The label span is cut with an ellipsis when it overflows
     *   ([data-press-label]{overflow:hidden;text-overflow:ellipsis}), and the button, capped at
     *   its box and padded, left too little room in a scaled-down 28px slice (two blanks drew the
     *   "…" as two dots); so the box reaches one cell past the slice on each side, giving the
     *   label room at any scale while the artwork stays the slice's;
     * - a plain button is painted on hover (button[data-press-plain]:hover, background
     *   fill.ghost.hover). The button's own `hover` overrides that, written !important and scoped
     *   to the keyed holder, but only with a colour the app's resolver accepts: a #hex or an
     *   rgb()/hsl() of numbers ("transparent" is turned into currentColor and dropped, which is
     *   why the earlier override never applied). So: '#00000000'.
     */
    const BLANK = '\u2800'
    const NO_FILL = '#00000000'
    const pressable = (key: string, piece: Piece, onPress: () => void) => (
      <Box key={`${key}-holder`} flexDirection="column">
        {draw(piece)}
        <Box position="absolute" top={0} left={-1} right={-1} bottom={0} alignItems="center" justifyContent="center">
          <Button key={key} plain hover={{ backgroundColor: NO_FILL }} onPress={onPress}>
            {BLANK}
          </Button>
        </Box>
      </Box>
    )

    /**
     * The layout, all of it set by the drawings' own px widths, never by cells or percentages:
     * the root centres one column, and a column with no width takes its widest child's, the
     * 400px drawings; everything native inside it stretches to that. Heights: the body is
     * `bodyRows` cells (`lh`), so the Overview's root is exactly that, clipped (it can't
     * scroll), and the Activity view's at least that (its list scrolls the pane).
     */
    const column = (children: RenderElement[], fill: 'exact' | 'atLeast') => (
      <Box
        flexDirection="column"
        alignItems="center"
        {...(fill === 'exact' ? { height: bodyRows, overflow: 'hidden' as const } : { minHeight: bodyRows })}
      >
        {/* minHeight 0: the column may be squeezed (the agents area gives way), never the root overflowed. */}
        <Box flexDirection="column" flexGrow={1} minHeight={0}>
          {children}
        </Box>
      </Box>
    )
    /** Height the drawings don't use: kept at the bottom, under the cards, never between sections. */
    const give = () => <Box flexGrow={1} />

    // Measuring, only while /mission measure runs: one drawing of known height.
    if (measuringNow) {
      return column([draw(measuring(now, theme))], 'atLeast')
    }

    if (shown === 'activity') {
      const [summary, list] = activity(data, now, theme)
      const items: RenderElement[] = [
        // Header: Back (the drawn 28px square with the chevron-left, 12px in, then 8px),
        // "Activity / CURRENT TASK" from the design's x 48, the pill at the right.
        <Box flexDirection="row" alignItems="center">
          {(() => {
            // Back as three bands: the 12px before the square, the square (the press target), the 8px after.
            const back = backPiece(theme)
            const after = BACK_SQUARE.x + BACK_SQUARE.width
            return [
              draw(slice(back, 0, BACK_SQUARE.x, 'back-before', 'Back')),
              pressable('mission-back', slice(back, BACK_SQUARE.x, BACK_SQUARE.width, 'back-square', 'Back to the overview'), () =>
                void update($, view, () => 'overview' as MissionView),
              ),
              draw(slice(back, after, back.width - after, 'back-after', 'Back')),
            ]
          })()}
          <Text weight="semibold" {...strong}>
            Activity
          </Text>
          <Box width={1} />
          <Text size="caption" mono {...quieter}>
            / CURRENT TASK
          </Text>
          <Box flexGrow={1} />
          {draw(pill(data, now, theme))}
        </Box>,
      ]
      if (summary) items.push(draw(summary))
      if (list) items.push(draw(list))
      return column(items, 'atLeast')
    }

    // The Overview fills the body: its px height is bodyRows cells, laid out in the drawings' own
    // units (divided by the scale, as they are drawn multiplied by it); the row is one cell tall.
    const parts = overview(data, now, theme, { height: budget / scale, rowPx: Math.ceil(row) / scale })
    const card = parts.card
    const open = () => void update($, view, () => 'activity' as MissionView)
    const items: RenderElement[] = [draw(parts.header)]
    if (parts.notice) items.push(draw(parts.notice))
    if (parts.loading) items.push(draw(parts.loading))
    if (card) {
      items.push(
        // The task card: a column as wide as its 376px drawings. Its update row is one drawing
        // (border, dot, who, what, when, the chevron) with a press target over the whole of it.
        <Box key="mission-card" flexDirection="column" alignSelf="center">
          {draw(card.top)}
          <Box flexDirection="row">
            {draw(card.row[0] as Piece)}
            {pressable('mission-open-activity', card.row[1] as Piece, open)}
            {draw(card.row[2] as Piece)}
          </Box>
          {draw(card.cap)}
        </Box>,
      )
    }
    // The gaps between sections are the design's, fixed: no flexible space between them. A taller
    // pane grows the agents area (graph, then cards, to their caps); what is left stays at the bottom.
    for (const piece of parts.after) {
      items.push(
        piece.key === 'agents' ? (
          <Box flexDirection="column" flexShrink={1} minHeight={0} overflow="hidden">
            {[
              draw(piece),
              // An event's packets: their own drawing over the agents', played once as it appears.
              ...(parts.packets
                ? [
                    <Box position="absolute" top={0} left={0}>
                      {svgOf(steady('agents-packets', asShown(parts.packets)))}
                    </Box>,
                  ]
                : []),
            ]}
          </Box>
        ) : (
          draw(piece)
        ),
      )
    }
    items.push(give())
    return column(items, 'exact')
  })
}
