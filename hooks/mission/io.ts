/**
 * The plugin's writes to the data folder: the orchestrator's reports, a helper's own lines, and the
 * automatic reports (auto.ts). One at a time, so two writes from this session never interleave.
 */

import type { EngineInterface } from 'claude-code'

import { orchestratorOf, parseState, type McEvent, type McState } from './model'
import { apply, appendLines, emptyState, roleName, sayEvent, stateText, tooSoon, turnState, type Report } from './writer'

export type Paths = { dir: string; state: string; events: string }
let paths: Promise<Paths> | null = null

/**
 * The data folder: MC_DIR when set, else `<home>/.claude/mission-control`, the home directory
 * read from the environment at run time (HOME on macOS and Linux, USERPROFILE on Windows) and
 * CLAUDE_CONFIG_DIR standing in for `<home>/.claude` when set, as it does for Claude Code itself.
 * Forward slashes throughout: Windows takes them in a path as well as backslashes.
 */
export function pathsOf($: EngineInterface): Promise<Paths> {
  paths ??= (async () => {
    const slash = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')
    const override = await $.env.get('MC_DIR')
    let dir: string
    if (override) {
      dir = slash(override)
    } else {
      const config = await $.env.get('CLAUDE_CONFIG_DIR')
      const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
      // No home folder found (and no MC_DIR or CLAUDE_CONFIG_DIR): no folder at all, so nothing is
      // read or written, rather than a folder at the root of the disk.
      if (!config && !home) return { dir: '', state: '', events: '' }
      dir = `${config ? slash(config) : `${slash(home)}/.claude`}/mission-control`
    }
    return { dir, state: `${dir}/state.json`, events: `${dir}/events.jsonl` }
  })()
  return paths
}

/**
 * The state with the orchestrator as its agents show it (model.ts `orchestratorOf`), so state.json
 * says what the pane draws; the CLI writes it by the same rule.
 */
export const settled = (state: McState): McState => ({ ...state, orchestrator: orchestratorOf(state) })

/** Writes one at a time. */
let writing: Promise<unknown> = Promise.resolve()
export function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = writing.then(work)
  writing = run.catch(() => undefined)
  return run
}

/** Told after every write that changed something: the state written, or null for the log alone. */
let onWritten: ((state: McState | null) => void) | null = null
/** Also told after every write: the transcript follower, so a card it would correct is never left wrong. */
let alsoWritten: (() => void) | null = null
export const afterWrite = (listener: () => void): void => {
  alsoWritten = listener
}
export const whenWritten = (listener: (state: McState | null) => void): void => {
  onWritten = listener
}

/**
 * The stored state: an empty one when there is none (a sample state also starts clean), and
 * `bad` when the file holds something that isn't a state (cut short, say), which the caller keeps.
 */
export function stateFrom(raw: string, now: number): { state: McState; bad: boolean } {
  if (raw.trim() === '') return { state: emptyState(now), bad: false }
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'object' && value !== null && 'demo' in value && value.demo) return { state: emptyState(now), bad: false }
  } catch {
    return { state: emptyState(now), bad: true }
  }
  const parsed = parseState(raw)
  return parsed ? { state: parsed, bad: false } : { state: emptyState(now), bad: true }
}

/** A file's text; `''` when it isn't there, `null` when it is there and could not be read. */
export async function readIfThere($: EngineInterface, path: string): Promise<string | null> {
  if (!(await $.fs.exists(path).catch(() => false))) return ''
  return $.fs.read(path).catch(() => null)
}

export type Written = { applied: number; error?: string; notes: string[] }

/** How far back the duplicate guard looks for a dispatch with no report after it. */
export const DEDUPE_MS = 10 * 60_000

/**
 * The log line this dispatch or report repeats, if any, whoever wrote it: one report per dispatch
 * (a report from an agent that has already reported since its last dispatch), and no second
 * dispatch to an agent before it has reported, within DEDUPE_MS. Names compare without case.
 */
function repeated(lines: string[], event: McEvent): { index: number; auto: boolean } | null {
  if (TASK_ENDS.has(event.type)) return sameTaskEnd(lines, event)
  if (event.type !== 'dispatch' && event.type !== 'report') return null
  const agent = (event.type === 'report' ? event.from : event.to).toLowerCase()
  for (let index = lines.length - 1, seen = 0; index >= 0 && seen < 200; index--, seen++) {
    const line = lines[index]?.trim()
    if (!line) continue
    let earlier: Partial<McEvent>
    try {
      earlier = JSON.parse(line) as Partial<McEvent>
    } catch {
      continue
    }
    const from = String(earlier.from ?? '').toLowerCase()
    const to = String(earlier.to ?? '').toLowerCase()
    const isReport = earlier.type === 'report' && from === agent
    const isDispatch = earlier.type === 'dispatch' && to === agent
    if (!isReport && !isDispatch) continue
    const same = event.type === 'report' ? isReport : isDispatch && event.time - Number(earlier.time) <= DEDUPE_MS
    return same ? { index, auto: earlier.auto === true } : null
  }
  return null
}

/** A task's start or end: one line each per task, whoever logs it. */
const TASK_ENDS: ReadonlySet<string> = new Set(['task_started', 'task_done', 'task_failed'])
/** The line logging the same start or end of the same task as `event`, if any (within the last 200). */
function sameTaskEnd(lines: string[], event: McEvent): { index: number; auto: boolean } | null {
  if (!event.taskId) return null
  for (let index = lines.length - 1, seen = 0; index >= 0 && seen < 200; index--, seen++) {
    const line = lines[index]?.trim()
    if (!line) continue
    let earlier: Partial<McEvent>
    try {
      earlier = JSON.parse(line) as Partial<McEvent>
    } catch {
      continue
    }
    if (earlier.type === event.type && earlier.taskId === event.taskId) return { index, auto: earlier.auto === true }
  }
  return null
}

/**
 * The log with `event` placed: an automatic event that repeats one already there is dropped; the
 * orchestrator's (or a helper's) own event that repeats an automatic one takes its place; two of
 * their own are both kept. So when both arrive, in either order, the manual copy is the one kept.
 */
export function placeEvent(log: string, event: McEvent): string {
  const lines = log.split('\n')
  const match = repeated(lines, event)
  if (match && event.auto) return log
  if (match && match.auto) {
    lines.splice(match.index, 1)
    return appendLines(lines.join('\n'), [JSON.stringify(event)])
  }
  return appendLines(log, [JSON.stringify(event)])
}

/**
 * Applies `updates` in order and writes the files: new events appended to events.jsonl (rotated
 * past its limit), then state.json whole. `updates` may be a function of the stored state (the
 * automatic reports decide from what is there). Stops at the first update that fails, writing
 * those before it. A dispatch or report already logged in the last DEDUPE_MS is not logged again.
 * The engine's file write has no rename, so a write is not atomic: the reader keeps its last good
 * state when it meets a half-written file, and reads the log only to its last complete line. A
 * state.json that is there but unreadable stops the report (nothing is lost); one that is not a
 * state is kept as state.json.bad before a clean one replaces it. A log that is there but
 * unreadable is left alone, and this report's events are not written.
 */
/** What a write answers when no home folder was found. */
const NO_HOME = 'no home folder was found (HOME or USERPROFILE), so Mission Control writes nothing; set MC_DIR to choose a folder'

export function report($: EngineInterface, updates: Report[] | ((state: McState) => Report[])): Promise<Written> {
  return serially(async (): Promise<Written> => {
    const { state: STATE_FILE, events: EVENTS_FILE } = await pathsOf($)
    if (!STATE_FILE) return { applied: 0, error: NO_HOME, notes: [] }
    const now = await $.clock.now()
    const notes: string[] = []
    const raw = await readIfThere($, STATE_FILE)
    if (raw === null) return { applied: 0, error: 'could not read state.json', notes }
    const stored = stateFrom(raw, now)
    let state = stored.state
    const list = typeof updates === 'function' ? updates(state) : updates
    if (list.length === 0) return { applied: 0, notes }
    const events: McEvent[] = []
    let applied = 0
    let error: string | undefined
    for (const [index, item] of list.entries()) {
      const result = apply(state, item, now + index, () => crypto.randomUUID().slice(0, 8))
      if (result.error !== undefined) {
        error = `update ${index + 1} (${String(item.do)}): ${result.error}`
        break
      }
      state = result.state
      // Every event carries the task that was current when it was written.
      if (result.event) events.push(state.task && !result.event.taskId ? { ...result.event, taskId: state.task.id } : result.event)
      applied += 1
    }
    if (applied > 0) {
      if (stored.bad) {
        await $.fs.write(`${STATE_FILE}.bad`, raw)
        notes.push('state.json was not a valid state; it was kept as state.json.bad and a clean state started')
      }
      if (events.length > 0) {
        const log = await readIfThere($, EVENTS_FILE)
        if (log === null) notes.push(`events.jsonl could not be read, so its history was left as it was and ${events.length} event(s) were not written`)
        else {
          let text = log
          for (const event of events) text = placeEvent(text, event)
          if (text !== log) await $.fs.write(EVENTS_FILE, text)
        }
      }
      state = settled(state)
      await $.fs.write(STATE_FILE, stateText(state))
      onWritten?.(state)
      alsoWritten?.()
    }
    return error === undefined ? { applied, notes } : { applied, error, notes }
  })
}

/**
 * The orchestrator's own turn begins (`open`) or ends (writer.ts `turnState`). A state file that is
 * not a state is left for the next report to keep.
 */
export function writeTurn($: EngineInterface, open: boolean, log = ''): Promise<void> {
  return serially(async () => {
    const { state: STATE_FILE } = await pathsOf($)
    if (!STATE_FILE) return
    const raw = await readIfThere($, STATE_FILE)
    if (raw === null) return
    const stored = stateFrom(raw, await $.clock.now())
    // Ending a turn that is not stored (already ended, or never opened) writes nothing.
    if (stored.bad || (!open && stored.state.orchestrator.turn === undefined)) return
    const state = settled(turnState(stored.state, open, await $.clock.now(), log))
    await $.fs.write(STATE_FILE, stateText(state))
    onWritten?.(state)
    alsoWritten?.()
  })
}

/**
 * The person has answered the orchestrator (their own prompt): its NEEDS YOU, if it stands, gives
 * way to IDLE, and the turn that prompt opens shows WORKING. Anything else is left as it is.
 */
export function answered($: EngineInterface): Promise<void> {
  return serially(async () => {
    const { state: STATE_FILE } = await pathsOf($)
    if (!STATE_FILE) return
    const raw = await readIfThere($, STATE_FILE)
    const stored = raw ? parseState(raw) : null
    if (stored?.orchestrator.status !== 'needs_user') return
    const now = await $.clock.now()
    const state = settled({ ...stored, orchestrator: { ...stored.orchestrator, status: 'idle', since: now }, lastUpdated: now })
    await $.fs.write(STATE_FILE, stateText(state))
    onWritten?.(state)
    alsoWritten?.()
  })
}

/**
 * A new conversation opens the pane on the empty state: when the stored task is done or failed, the
 * task, plan and agents are cleared and the orchestrator is idle; the queue is kept and events.jsonl
 * is left as it is. A running or paused task, no state, or a file that is not a state is left alone.
 * True when it cleared.
 */
export function clearFinished($: EngineInterface): Promise<boolean> {
  return serially(async () => {
    const { state: STATE_FILE } = await pathsOf($)
    if (!STATE_FILE) return false
    const raw = await readIfThere($, STATE_FILE)
    const stored = raw ? parseState(raw) : null
    const status = stored?.task?.status
    if (!stored || (status !== 'done' && status !== 'failed')) return false
    const state = settled({ ...emptyState(await $.clock.now()), queue: stored.queue })
    await $.fs.write(STATE_FILE, stateText(state))
    onWritten?.(state)
    alsoWritten?.()
    return true
  })
}

/**
 * A plain line that opens with one of these, from a working agent, is its report: Done, Finished,
 * Handing in, PASS or FAIL; Final and Report only with a colon or dash (-, –, —) right after the word,
 * since "Report line fixed", "Final checks running" or a bare "Final" are progress.
 */
export const HAND_IN = /^\s*(?:(?:done|finished|handing in|pass|fail)\b|(?:final|report)[:\-–—])/i

/** A helper's line as it counts: a working agent's line opening with a hand-in word is its report. */
export function asHandIn(state: McState, event: McEvent): McEvent {
  if (event.type !== 'progress' || !HAND_IN.test(event.text)) return event
  const agent = state.agents.find(each => each.name.toLowerCase() === event.from.toLowerCase())
  return agent?.status === 'working' ? { ...event, type: 'report', to: 'orchestrator' } : event
}

/**
 * What a helper's own line does to its own card, and nothing else's. Its report hands in: working or
 * needs-you to in review, the report as its line, the timer stopped. Any other line from an agent
 * that is not working (queued, idle, in review, done) means it has started a job: working, the timer
 * restarted, that line as its task (queued or idle keep a task the orchestrator set). So a working
 * helper never shows In review.
 */
export function ownStatus(state: McState, event: McEvent): Report | null {
  const agent = state.agents.find(each => each.name.toLowerCase() === event.from.toLowerCase())
  const status = agent?.status ?? 'idle'
  const name = agent?.name ?? roleName(event.from)
  if (event.type === 'report') {
    return status === 'working' || status === 'needs_user' ? { do: 'agent', name, status: 'in_review', task: event.text } : null
  }
  if (status === 'working' || status === 'needs_user') return null
  const keep = (status === 'queued' || status === 'idle') && Boolean(agent?.currentTask)
  return { do: 'agent', name, status: 'working', ...(keep ? {} : { task: event.text }) }
}

/**
 * A helper's own lines (the tool called with `as`): progress or report events from that role,
 * appended to the log; and its own card moved as `ownStatus` says (its hand-in, its start), nothing
 * else in state.json. A progress line within PROGRESS_GAP_MS of the same agent's last one is
 * dropped without a word.
 */
export function say($: EngineInterface, as: unknown, updates: Report[]): Promise<Written> {
  return serially(async (): Promise<Written> => {
    const { events: EVENTS_FILE } = await pathsOf($)
    if (!EVENTS_FILE) return { applied: 0, error: NO_HOME, notes: [] }
    const now = await $.clock.now()
    const lines: McEvent[] = []
    for (const [index, item] of updates.entries()) {
      const made = sayEvent(as, item, now + index)
      if ('error' in made) return { applied: 0, error: `update ${index + 1}: ${made.error}`, notes: [] }
      lines.push(made.event)
    }
    const log = await readIfThere($, EVENTS_FILE)
    if (log === null) return { applied: 0, error: 'could not read events.jsonl', notes: [] }
    // Its own card, read now, in this same turn of writes, so the hand-in shows within the pane's next read.
    const { state: STATE_FILE } = await pathsOf($)
    const raw = await readIfThere($, STATE_FILE)
    const stored = raw === null ? null : stateFrom(raw, now)
    const task = stored && !stored.bad ? stored.state.task : null
    const stamped = task ? lines.map(event => ({ ...event, taskId: task.id })) : lines
    const counted = stored && !stored.bad ? stamped.map(event => asHandIn(stored.state, event)) : stamped
    let text = log
    for (const event of counted) {
      if (tooSoon(text, event)) continue
      text = placeEvent(text, event)
    }
    if (text !== log) await $.fs.write(EVENTS_FILE, text)
    let changed: McState | null = null
    if (stored) {
      if (!stored.bad) {
        let state = stored.state
        for (const event of counted) {
          const move = ownStatus(state, event)
          if (!move) continue
          const result = apply(state, move, now, () => crypto.randomUUID().slice(0, 8))
          if (result.error === undefined) state = result.state
        }
        if (state !== stored.state) {
          state = settled(state)
          await $.fs.write(STATE_FILE, stateText(state))
          changed = state
        }
      }
    }
    if (text !== log || changed) {
      onWritten?.(changed)
      alsoWritten?.()
    }
    return { applied: updates.length, notes: [] }
  })
}
