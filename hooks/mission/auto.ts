/**
 * Automatic reporting: the routine bookkeeping the orchestrator used to write by hand.
 *
 * - Outgoing: a brief to a helper (SendMessage, start_session, the Agent tool) is seen at
 *   `tool.call`, which this only observes: it calls `next(e)` unchanged and returns its result.
 *   It logs a dispatch (the brief's summary or first line, never the whole message), sets the
 *   agent working and the orchestrator waiting on it.
 * - Incoming: a helper's result. A subagent's arrives as its Agent call's result; a side session's
 *   as the note the app delivers when it finishes a turn, seen at `session.receive` (on arrival)
 *   and `prompt.submit` (when it is put to the model), whichever comes, once. It logs a report (the
 *   first sentence), sets the agent in review and the orchestrator reviewing.
 * - A helper's own permission prompt, in the helper's session (`classic.PermissionRequest`): its
 *   own agent goes NEEDS YOU with the question, and back to what it was once the call is answered.
 *
 * Never automatic: the task, the plan, the queue, done or sent back, needs-you for a question the
 * orchestrator asks, idle, paused. The orchestrator's own writes win: an automatic one never
 * changes an agent whose status changed after the message that triggered it, and a dispatch or
 * report logged twice within a few seconds is logged once (io.ts). Nothing leaves the machine.
 */

import type { EngineInterface, On } from 'claude-code'

import { afterWrite, pathsOf, readIfThere, report, writeTurn } from './io'
import { parseState, type McState } from './model'
import { projectFolderOf, turnOf, type Turn } from './transcript'
import { clip, type Report } from './writer'

/** The four default roles: a session or agent whose title, name or type holds one of these is it. */
export const ROLES = ['Explorer', 'Worker', 'Tester', 'Security'] as const

const BRIEF_TOOLS = new Set(['SendMessage', 'Agent', 'mcp__ccd_session__start_session'])

// ---- what this session knows ----------------------------------------------------------------------

/** Ids and handles of sessions this one started or heard of, to their titles. */
const titles = new Map<string, string>()
/** `/mission agents`: a role to the id, handle or title words that name it (stored for the plugin). */
let explicit: Record<string, string> = {}
/** Automatic reporting on (the default) or off (`/mission auto off`). */
let enabled = true
/** This session is a helper, with this role: learned from its brief, or set with `/mission role`. */
let helperRole: string | null = null
/** This session has briefed someone: it is an orchestrator, never a helper. */
let briefed = false

const STORE_AUTO = 'auto'
const STORE_ROLES = 'roles'
const STORE_TITLES = 'titles'
const STORE_DEBUG = 'debug'

/** The plugin's version, read from its own plugin.json at load (one place); shown in replies and the debug file. */
let version = ''
/** "Mission Control" with its version, when one was read. */
const titled = (): string => (version ? `Mission Control ${version}` : 'Mission Control')

/** `/mission debug on`: each brief tool call (its name and input keys only) and each note's handling, to `.panel-debug.json`. */
let debug = false
let loadedAt = 0
/** Ids the learned titles had when last kept, so a new one is kept at once. */
let keptTitles = 0

/** Loads the switch and the explicit roles (kept by the plugin across sessions). */
export async function loadAuto($: EngineInterface, defaults: { debug?: boolean; orchestrator?: boolean } = {}): Promise<void> {
  loadedAt = await $.clock.now()
  version = await versionOf($)
  const id = await $.session.id().catch(() => '')
  const known = await $.store.get(STORE_ORCH).catch(() => undefined)
  orchestrating = defaults.orchestrator === true || (id !== '' && Array.isArray(known) && known.includes(id))
  // A new load knows of no running turn: one stored by an earlier load (before a restart, a reload,
  // an app that quit mid-turn) is ended, so its PLANNING, DISPATCHING or WORKING is not shown. A turn
  // that is in fact running opens again at its next tool call.
  turnOpen = false
  await closeTurn($).catch(() => undefined)
  const on = await $.store.get(STORE_AUTO).catch(() => undefined)
  enabled = on !== false
  const wantWatch = await $.store.get(STORE_WATCH).catch(() => undefined)
  watchOn = wantWatch !== false
  const wantDebug = await $.store.get(STORE_DEBUG).catch(() => undefined)
  debug = typeof wantDebug === 'boolean' ? wantDebug : defaults.debug === true
  const kept = await $.store.get(STORE_TITLES).catch(() => undefined)
  if (kept && typeof kept === 'object') {
    for (const [id, title] of Object.entries(kept)) if (typeof title === 'string' && !titles.has(id)) titles.set(id, title)
    keptTitles = titles.size
  }
  const roles = await $.store.get(STORE_ROLES).catch(() => undefined)
  if (roles && typeof roles === 'object') explicit = Object.fromEntries(Object.entries(roles).filter(([, v]) => typeof v === 'string')) as Record<string, string>
}

/** The version in this plugin's manifest (`<root>/plugin.json` or `<root>/.claude-plugin/plugin.json`), or ''. */
async function versionOf($: EngineInterface): Promise<string> {
  for (const path of [`${$.plugin.root}/plugin.json`, `${$.plugin.root}/.claude-plugin/plugin.json`]) {
    try {
      const manifest: unknown = JSON.parse(await $.fs.read(path))
      if (manifest && typeof manifest === 'object' && 'version' in manifest && typeof manifest.version === 'string') return manifest.version
    } catch {
      // Not here: the next place.
    }
  }
  return ''
}

/** The role for a recipient: an explicit mapping first, then a role's name in its title or handle. */
export function roleFor(key: string): string | null {
  const id = key.trim()
  if (!id) return null
  const title = titles.get(id) ?? ''
  const words = `${id} ${title}`.toLowerCase()
  for (const [role, pattern] of Object.entries(explicit)) {
    const p = pattern.trim().toLowerCase()
    if (p && (id.toLowerCase() === p || words.includes(p))) return role
  }
  return ROLES.find(role => words.includes(role.toLowerCase())) ?? null
}

/** Learns ids and titles from any text the session sees: start_session results and the app's notes. */
export function learnNames(text: string): void {
  const patterns = [
    /"([^"\n]{1,80})"[^\n]{0,40}?\((local_[\w-]+)\)/g,
    /\[([^\]\n]{1,80})\]\(#(local_[\w-]+)\)/g,
    /from="(local_[\w-]+)" from-name="([^"\n]{1,80})"/g,
  ]
  for (const [index, pattern] of patterns.entries()) {
    for (const match of text.matchAll(pattern)) {
      const [title, id] = index === 2 ? [match[2], match[1]] : [match[1], match[2]]
      if (title && id) titles.set(id, title)
    }
  }
  for (const match of text.matchAll(/\bname["']?\s*[:=]\s*["']?([a-z0-9-]{2,24})["']?[^\n]{0,80}?(local_[\w-]+)/gi)) {
    if (match[1] && match[2]) titles.set(match[1], titles.get(match[2]) ?? match[1])
  }
  // A role's name and a session id on one line (the linked-sessions list, a status table): that id
  // is that role, unless a title is already known for it.
  for (const match of text.matchAll(/\b(Explorer|Worker|Tester|Security)\b[^\n]{0,60}?\b(local_[0-9a-f]{8}-[0-9a-f-]{20,40})/gi)) {
    if (match[1] && match[2] && !titles.has(match[2])) titles.set(match[2], match[1])
  }
}

/** Keeps the learned ids and titles with the plugin, so a reload still knows them. */
async function keepTitles($: EngineInterface): Promise<void> {
  if (titles.size === keptTitles) return
  keptTitles = titles.size
  await $.store.set(STORE_TITLES, Object.fromEntries(titles))
}

/** The debug file's recent entries: brief calls and notes, newest last. */
const traces: Record<string, unknown>[] = []

/** With debug on: one entry (never a message's text) to `.panel-debug.json` in the data folder. */
async function trace($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  if (!debug) return
  traces.push({ time: await $.clock.now(), ...entry })
  traces.splice(0, Math.max(0, traces.length - 30))
  await writeDebug($)
}

/** The pane's last numbers: its columns and rows, the cell in use, where it came from, the scale. */
let panel: Record<string, unknown> | null = null

/** With debug on: the pane's numbers into the debug file, on every change (the pane calls this). */
export async function notePanel($: EngineInterface, numbers: Record<string, unknown>): Promise<void> {
  panel = { time: await $.clock.now(), ...numbers }
  if (debug) await writeDebug($)
}

async function writeDebug($: EngineInterface): Promise<void> {
  const { dir } = await pathsOf($)
  if (!dir) return
  const file = {
    version,
    loadedAt,
    automatic: enabled,
    roles: explicit,
    learned: Object.fromEntries(titles),
    helperRole,
    watching: watchOn,
    following: Object.fromEntries([...followed].map(([role, f]) => [role, { path: f.path.split('/').slice(-2).join('/'), turn: f.turn?.state ?? null }])),
    panel,
    traces,
  }
  await $.fs.write(`${dir}/.panel-debug.json`, `${JSON.stringify(file, null, 1)}\n`)
}

/** A role as events carry it: its lower-case id, the form the orchestrator's own events use. */
const idOf = (role: string): string => role.toLowerCase()

/** The first line of a text, one line, at most `limit` characters. */
const firstLine = (text: unknown, limit: number): string => clip(String(text ?? '').split('\n').find(line => line.trim()) ?? '', limit)

// ---- the writes -------------------------------------------------------------------------------------

/** The orchestrator's names of those it waits on, with `role` added. */
const waitingWith = (state: McState, role: string): string[] => {
  const names = state.orchestrator.status === 'waiting' ? state.orchestrator.waitingOn : []
  return [...names.filter(name => name.toLowerCase() !== role.toLowerCase()), role]
}

/** Whether the agent has already handed in (its own report line moved it): the note then changes nothing. */
const isInReview = (state: McState, role: string): boolean =>
  state.agents.some(each => each.name.toLowerCase() === role.toLowerCase() && each.status === 'in_review')

/** Whether the agent's status changed after `since` (the orchestrator's own write wins). */
const changedSince = (state: McState, role: string, since: number): boolean => {
  const agent = state.agents.find(each => each.name.toLowerCase() === role.toLowerCase())
  return agent !== undefined && agent.startedAt > since
}

/** A brief went out to `role`: dispatch, the agent working on it, the orchestrator waiting. */
export function dispatch($: EngineInterface, role: string, text: string, at: number): Promise<unknown> {
  return report($, (state: McState): Report[] =>
    changedSince(state, role, at)
      ? [{ do: 'event', type: 'dispatch', from: 'orchestrator', to: idOf(role), text, auto: true }]
      : [
          { do: 'event', type: 'dispatch', from: 'orchestrator', to: idOf(role), text, auto: true },
          { do: 'agent', name: role, status: 'working', task: text },
          { do: 'orch', status: 'waiting', waitingOn: waitingWith(state, role) },
        ],
  )
}

/**
 * What an automatic hand-in says: the helper's own report line for this job when it wrote one, else
 * just "Handed in". Never words taken from its answer, a note or a transcript: only what it chose to
 * report reaches the log and the pane.
 */
const handedIn = (own: Map<string, string>, role: string): { line: string; task: string } => {
  const line = own.get(role.toLowerCase())
  return line ? { line, task: clip(`Reported: ${line}`, 80) } : { line: 'Handed in', task: 'Handed in' }
}

/** A helper's result arrived: report, the agent in review, the orchestrator reviewing it. */
export async function handIn($: EngineInterface, role: string, at: number): Promise<unknown> {
  const log = await logged($)
  const { line, task } = handedIn(log.own, role)
  return report($, (state: McState): Report[] =>
    // Already accepted for a task that is over: logged, and its card stays as it is.
    changedSince(state, role, at) || isInReview(state, role) || settledFor(log, role)
      ? [{ do: 'event', type: 'report', from: idOf(role), to: 'orchestrator', text: line, auto: true }]
      : [
          { do: 'event', type: 'report', from: idOf(role), to: 'orchestrator', text: line, auto: true },
          { do: 'agent', name: role, status: 'in_review', task },
          { do: 'orch', status: 'reviewing', reviewing: [role] },
        ],
  )
}

/** A helper's session stopped or failed: say so, and leave its status to the orchestrator. */
export function stopped($: EngineInterface, role: string, how: string): Promise<unknown> {
  return report($, [{ do: 'event', type: 'progress', from: idOf(role), to: '', text: how, auto: true }])
}

// ---- outgoing -----------------------------------------------------------------------------------------

/** What one brief tool call says: whom it is for and its one line. */
export function briefOf(tool: string, input: Record<string, unknown>): { key: string; text: string } | null {
  if (tool === 'SendMessage') {
    const key = typeof input.to === 'string' ? input.to : ''
    const text = typeof input.summary === 'string' && input.summary.trim() ? clip(input.summary, 100) : firstLine(input.message, 100)
    return key && text ? { key, text } : null
  }
  if (tool === 'Agent') {
    const key = [input.subagent_type, input.name, input.description].filter(value => typeof value === 'string').join(' ')
    const text = typeof input.description === 'string' && input.description.trim() ? clip(input.description, 100) : firstLine(input.prompt, 100)
    return key && text ? { key, text } : null
  }
  if (tool === 'mcp__ccd_session__start_session') {
    const key = [input.name, input.title].filter(value => typeof value === 'string').join(' ')
    const text = typeof input.title === 'string' && input.title.trim() ? clip(input.title, 100) : firstLine(input.prompt, 100)
    return key && text ? { key, text } : null
  }
  return null
}

/** Whether an Agent call's answer is a background launch (no result yet), not a subagent's result. */
const isLaunch = (text: string): boolean => /\b(in the background|running in background|async agent|agent launched|teammate_spawned)\b/i.test(text)

// ---- incoming ---------------------------------------------------------------------------------------------

/** The app's note when a session this one started ends a turn: its id, title and how it ended (never what it said). */
export function noteOf(text: string): { id: string; title: string; how: 'finished' | 'stopped' | 'failed' } | null {
  const head = text.match(/(?:session|Session)\s+"([^"\n]{1,80})"[^\n]{0,60}?\((local_[\w-]+)\)\s*([^\n]*)/)
  if (!head) return null
  const [, title = '', id = '', rest = ''] = head
  // How it ended is said before what it reported: "6 checks failed" in a report is not a failed session.
  const said0 = rest.split(/\breported\b|\.\s/i)[0] ?? ''
  const how = /\b(failed|errored)\b/i.test(said0) ? 'failed' : /\b(stopped|interrupted|cancelled|canceled)\b/i.test(said0) ? 'stopped' : /\b(finished|ended|completed)\b/i.test(said0) ? 'finished' : null
  if (!how) return null
  return { id, title, how }
}

/** Notes already handled (by their opening): one note arrives at two events. */
const seen = new Map<string, number>()
const firstTime = (text: string, now: number): boolean => {
  for (const [key, at] of seen) if (now - at > 120_000) seen.delete(key)
  const key = text.slice(0, 240)
  if (seen.has(key)) return false
  seen.set(key, now)
  return true
}

/** A helper's role in its own brief: the line the orchestrator puts there (`as: "<role>"`, `--as <role>`). */
export function roleInBrief(text: string): string | null {
  const match = text.match(/(?:--as\s+|\bas["']?\s*:\s*["'])([a-z][\w-]{1,23})/i)
  if (!match?.[1]) return null
  const name = match[1]
  return ROLES.find(role => role.toLowerCase() === name.toLowerCase()) ?? `${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`
}

// ---- a helper's own permission prompt ------------------------------------------------------------------------

/** The question a permission prompt asks, in plain words, at most 80 characters. */
export function questionOf(tool: string, input: unknown): string {
  // "Allow or deny:", the tool's short name, and only what cannot carry a secret: a file's name (no
  // path), a site's host (no path or query), and never a command.
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const name = tool.replace(/^mcp__.+?__/, '')
  const path = [fields.file_path, fields.path, fields.notebook_path].find(value => typeof value === 'string') as string | undefined
  let target = ''
  if (tool === 'Bash' || typeof fields.command === 'string') target = ''
  else if (path) target = path.split(/[\\/]/).pop() ?? ''
  else if (typeof fields.url === 'string') target = fields.url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i)?.[1] ?? (/^file:/i.test(fields.url) ? (fields.url.split(/[\\/]/).pop() ?? '') : '')
  return clip(`Allow or deny: ${name}${target ? ` ${clip(target, 60)}` : ''}`, 80)
}

let waitingFor: { role: string; question: string; task: string; status: string } | null = null

async function ownNeedsUser($: EngineInterface, role: string, question: string): Promise<void> {
  await report($, (state: McState): Report[] => {
    const agent = state.agents.find(each => each.name.toLowerCase() === role.toLowerCase())
    // Already waiting (the timed guess): the exact words replace it, and what to go back to stays.
    waitingFor = waitingFor && waitingFor.role === role ? { ...waitingFor, question } : { role, question, task: agent?.currentTask ?? '', status: agent?.status ?? 'working' }
    if (agent?.status === 'needs_user' && agent.currentTask === question) return []
    return [
      { do: 'agent', name: role, status: 'needs_user', task: question },
      { do: 'event', type: 'needs_user', from: idOf(role), to: 'orchestrator', text: question, auto: true },
    ]
  })
}

/** In a helper's session, a prompt it waited on has been answered: its card back to what it was. */
function settleOwn($: EngineInterface): void {
  if (waitingFor) void ownAnswered($, waitingFor.role).catch(() => undefined)
}

/**
 * This session's own role, when it is a helper: the role its brief named (`--as tester`), else the
 * one the orchestrator's watcher recorded for this session's transcript (ROLES_FILE), else none. An
 * orchestrating session has none. Kept once found, and recorded, so a reload does not lose it.
 */
async function ownRole($: EngineInterface): Promise<string | null> {
  if (orchestrating || briefed) return null
  if (helperRole) return helperRole
  const id = await $.session.id().catch(() => '')
  const role = id ? (await readRoles($))[id] : undefined
  if (role) helperRole = role
  return role ?? null
}

/** Helper sessions' roles by transcript id, beside state.json: written by the orchestrator's watcher and by a helper from its brief. */
const ROLES_FILE = '.roles.json'
async function readRoles($: EngineInterface): Promise<Record<string, string>> {
  const { dir } = await pathsOf($)
  if (!dir) return {}
  try {
    const value: unknown = JSON.parse(await $.fs.read(`${dir}/${ROLES_FILE}`))
    if (!value || typeof value !== 'object') return {}
    return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string' && /^[\w-]+$/.test(pair[0])))
  } catch {
    return {}
  }
}
async function recordRoles($: EngineInterface, roles: Record<string, string>): Promise<void> {
  const { dir } = await pathsOf($)
  if (!dir) return
  const known = await readRoles($)
  const merged = { ...known, ...roles }
  if (Object.entries(roles).every(([id, role]) => known[id] === role)) return
  // The newest 50 sessions are plenty: older ones are long finished.
  await $.fs.write(`${dir}/${ROLES_FILE}`, `${JSON.stringify(Object.fromEntries(Object.entries(merged).slice(-50)))}\n`)
}

/** How long a helper's own tool call may run before its card says it may be waiting on the person. */
export const PROMPT_WAIT_MS = 1000
let callSeq = 0

/**
 * A helper's own tool call (not a brief): when it is not a long-running kind and has not returned
 * after PROMPT_WAIT_MS, its card shows "May be waiting for you: <tool>" (the name only); a
 * permission prompt the engine reports replaces that with its exact words at once. Cleared when the
 * call returns (or fails, or is denied), by the next call, and when the turn ends.
 */
async function watchOwnCall<R>($: EngineInterface, tool: string, run: () => Promise<R>): Promise<R> {
  // A new call: whatever waited before is over.
  if (waitingFor) settleOwn($)
  const role = await ownRole($).catch(() => null)
  if (!role || runsLong(tool)) return run()
  const seq = ++callSeq
  const timer = $.clock.after(PROMPT_WAIT_MS, () => {
    if (callSeq === seq && !waitingFor) void ownNeedsUser($, role, clip(`May be waiting for you: ${tool.replace(/^mcp__.+?__/, '')}`, 80)).catch(() => undefined)
  })
  try {
    return await run()
  } finally {
    timer.cancel()
    if (callSeq === seq) {
      callSeq += 1
      settleOwn($)
    }
  }
}

async function ownAnswered($: EngineInterface, role: string): Promise<void> {
  const was = waitingFor
  waitingFor = null
  if (!was) return
  await report($, (state: McState): Report[] => {
    const agent = state.agents.find(each => each.name.toLowerCase() === role.toLowerCase())
    // Only its own NEEDS YOU is cleared: anything the orchestrator set meanwhile stands.
    if (agent?.status !== 'needs_user' || agent.currentTask !== was.question) return []
    const back = was.status === 'needs_user' ? 'working' : was.status
    return [{ do: 'agent', name: role, status: back, task: was.task }]
  })
}

// ---- the hooks -----------------------------------------------------------------------------------------------

/** A delivery or a submitted prompt: learn names, a helper's own role, and hand in a finished helper's note. */
/**
 * The deliveries the app itself sends (its notes when a session ends a turn, the linked-sessions
 * list, a helper's brief): only these are read for names, roles and hand-ins. Text the person
 * types or pastes (`composer`, `person`) is never acted on, whatever it looks like.
 */
const APP_ORIGINS = new Set([
  'submit:sdk',
  'submit:peer',
  'submit:coordinator',
  'submit:task-notification',
  'receive:peer',
  'receive:coordinator',
  'receive:task-notification',
  'receive:peer-send-message',
  'submit:peer-send-message',
])

async function incoming($: EngineInterface, kind: string, text: string): Promise<void> {
  if (!APP_ORIGINS.has(kind)) return
  const now = await $.clock.now()
  learnNames(text)
  await keepTitles($).catch(() => undefined)
  if (!briefed && !helperRole) {
    const own = roleInBrief(text)
    if (own) {
      helperRole = own
      // Kept for this session's transcript, so a reload (or a later load of the plugin) still knows it.
      const id = await $.session.id().catch(() => '')
      if (id) void recordRoles($, { [id]: own }).catch(() => undefined)
    }
  }
  const note = noteOf(text)
  if (note) void trace($, { note: kind, id: note.id, title: note.title, how: note.how, role: roleFor(note.id), automatic: enabled }).catch(() => undefined)
  if (!note || !enabled || helperRole || !firstTime(text, now)) return
  titles.set(note.id, note.title)
  const role = roleFor(note.id)
  if (!role) return
  if (note.how === 'finished') await handIn($, role, now)
  else await stopped($, role, note.how === 'failed' ? 'Its session failed before handing in' : 'Its session was stopped before handing in')
}


/**
 * Outgoing briefs (and a subagent's result), observed: the call goes on unchanged, its answer is
 * returned as it came. Called from the module's one `tool.call` hook for every tool but the
 * plugin's own (the engine takes one hook without a matcher per module).
 */
export async function watchCall<E extends { tool: unknown }, R>($: EngineInterface, e: E, next: (e: E) => Promise<R>): Promise<R> {
  const tool = String(e.tool)
  if (!BRIEF_TOOLS.has(tool)) {
    await openTurn($).catch(() => undefined)
    return watchOwnCall($, tool, () => next(e))
  }
  const input = e as unknown as Record<string, unknown>
  const brief = briefOf(tool, input)
  const at = await $.clock.now()
  briefed = true
  helperRole = null
  void markOrchestrating($).catch(() => undefined)
  await openTurn($).catch(() => undefined)
  const role = brief ? roleFor(brief.key) : null
  void trace($, { call: tool, keys: Object.keys(input).filter(key => key !== 'tool').sort(), to: typeof input.to === 'string' ? input.to : undefined, role, automatic: enabled }).catch(() => undefined)
  if (enabled && role && brief) void dispatch($, role, brief.text, at).catch(() => undefined)
  const answer = await next(e)
  const fields = (answer ?? {}) as { text?: unknown; result?: unknown; deny?: unknown }
  const said = typeof fields.text === 'string' ? fields.text : typeof fields.result === 'string' ? fields.result : ''
  if (tool === 'mcp__ccd_session__start_session' && said) {
    learnNames(said)
    const id = said.match(/local_[\w-]+/)?.[0]
    if (id && brief) titles.set(id, `${String(input.title ?? '')} ${String(input.name ?? '')}`.trim() || brief.key)
    void keepTitles($).catch(() => undefined)
  }
  // A subagent's answer: the orchestrator was waiting on this very call, so nothing it wrote can be
  // newer than the result (no guard against its own writes needed).
  if (tool === 'Agent' && enabled && role && said && fields.deny === undefined && !isLaunch(said)) {
    void handIn($, role, Number.POSITIVE_INFINITY).catch(() => undefined)
  }
  return answer
}

export function registerAuto(on: On): void {
  // Outgoing briefs: observed in the module's one tool.call hook, which calls watchCall (below).

  // Incoming notes: at arrival, and again (once) when put to the model.
  on('session.receive', async ($, e, next) => {
    void incoming($, `receive:${e.origin.kind}`, e.text).catch(() => undefined)
    return next(e)
  }).catch((_$, e, next) => next(e))
  on('prompt.submit', async ($, e, next) => {
    void incoming($, `submit:${e.origin.kind}`, e.text).catch(() => undefined)
    await openTurn($, true).catch(() => undefined)
    return next(e)
  }).catch((_$, e, next) => next(e))

  // The orchestrator's own turn, from the engine's own events (the main loop's, not a subagent's):
  // it starts; it completes however it ended (an answer, the person's interrupt, a refusal, an
  // error); the session ends (exit, /clear, resume, a signal: register.ts's session.end, the module's
  // one hook on it). The Stop hook below closes it too, and a pane reads the turn's transcript as the
  // backstop when none of these fires.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await openTurn($, true).catch(() => undefined)
    return next(e)
  }).catch((_$, e, next) => next(e))
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await closeTurn($).catch(() => undefined)
    return next(e)
  }).catch((_$, e, next) => next(e))


  // The turn-end guard: when the orchestrator is about to stop with a status it owes, it is asked once
  // (a Stop block re-prompts it in the same turn). Never twice in a row (stop_hook_active), never in
  // a helper's session, and once per agent per change of its status, so it cannot loop.
  on('classic.Stop', async ($, e, next) => {
    settleOwn($)
    const answer = await next(e)
    if (!orchestrating || helperRole || e.stop_hook_active) {
      await closeTurn($).catch(() => undefined)
      return answer
    }
    const reminder = await owed($).catch(() => null)
    // Blocked, the turn goes on; else it ends here.
    if (!reminder) await closeTurn($).catch(() => undefined)
    return reminder ? { ...answer, block: reminder } : answer
  }).catch((_$, e, next) => next(e))

  // A helper's own permission prompt: its agent NEEDS YOU with the question, until it is answered.
  on('classic.PermissionRequest', async ($, e, next) => {
    const role = await ownRole($).catch(() => null)
    if (role) void ownNeedsUser($, role, questionOf(e.tool_name, e.tool_input)).catch(() => undefined)
    return next(e)
  }).catch((_$, e, next) => next(e))
  // Answered: the call ran (its result, or its failure) or was denied. The turn's end clears it too
  // (in the Stop hook above), so a NEEDS YOU never outlives its prompt.
  on('classic.PostToolUse', async ($, e, next) => {
    settleOwn($)
    return next(e)
  }).catch((_$, e, next) => next(e))
  on('classic.PostToolUseFailure', async ($, e, next) => {
    settleOwn($)
    return next(e)
  }).catch((_$, e, next) => next(e))
  on('classic.PermissionDenied', async ($, e, next) => {
    settleOwn($)
    return next(e)
  }).catch((_$, e, next) => next(e))
}

// ---- the turn-end guard: no status goes stale because the orchestrator forgot -----------------------

/** This session orchestrates (it briefs helpers or writes the state): only here does the guard run. */
let orchestrating = false
const STORE_ORCH = 'orchestrating'

/** This session is the orchestrator: kept with the plugin under its session id, so a reload keeps it. */
export async function markOrchestrating($: EngineInterface): Promise<void> {
  if (orchestrating) return
  orchestrating = true
  const id = await $.session.id().catch(() => '')
  if (!id) return
  const known = await $.store.get(STORE_ORCH).catch(() => undefined)
  const ids = Array.isArray(known) ? known.filter((each): each is string => typeof each === 'string').slice(-20) : []
  if (!ids.includes(id)) await $.store.set(STORE_ORCH, [...ids, id])
}

/**
 * The orchestrator's own turn: opened at its prompt or its first tool call, closed when it stops. The
 * circle says WORKING while it runs, task or no task (writer.ts `turnState`). Only in the session that
 * orchestrates, never in a helper's, and not while automatic reporting is off.
 */
let turnOpen = false
export async function openTurn($: EngineInterface, fresh = false): Promise<void> {
  // A new prompt or turn.start always opens a new turn (one before it may have ended unseen, by an
  // interrupt); a tool call opens one only when none is open.
  if ((turnOpen && !fresh) || !enabled || helperRole || !orchestrating) return
  turnOpen = true
  await writeTurn($, true, await ownTranscript($).catch(() => ''))
}

/** This session's own transcript (where a pane reads whether its turn has ended), or ''. Kept once found. */
let ownLog = ''
async function ownTranscript($: EngineInterface): Promise<string> {
  if (ownLog) return ownLog
  const id = await $.session.id().catch(() => '')
  const root = await configDir($)
  if (!id || !root) return ''
  const cwd = await $.session.cwd().catch(() => '')
  const direct = cwd ? `${root}/projects/${projectFolderOf(cwd)}/${id}.jsonl` : ''
  if (direct && (await $.fs.exists(direct).catch(() => false))) return (ownLog = direct)
  for (const folder of await $.fs.list(`${root}/projects`).catch(() => [])) {
    const path = `${root}/projects/${folder.name}/${id}.jsonl`
    if (folder.kind === 'dir' && (await $.fs.exists(path).catch(() => false))) return (ownLog = path)
  }
  return ''
}
/** Also after a reload in the middle of a turn (which forgets `turnOpen`): the stored turn is what ends. */
export async function closeTurn($: EngineInterface): Promise<void> {
  turnOpen = false
  if (!orchestrating || helperRole) return
  await writeTurn($, false)
}

/** Reminders already given, one per agent per hand-in (its name and when its status changed). */
const reminded = new Set<string>()

/**
 * What the orchestrator still owes before its turn ends, or null: an agent in review it has not
 * accepted or sent back; an agent it set waiting on the person, who has written since; an agent
 * still working on a task that is finished. Each is said once per change of that agent's status.
 */
export async function owed($: EngineInterface): Promise<string | null> {
  const { state: STATE_FILE } = await pathsOf($)
  if (!STATE_FILE) return null
  const raw = await $.fs.read(STATE_FILE).catch(() => '')
  const state = parseState(raw)
  if (!state) return null
  const finished = state.task?.status === 'done' || state.task?.status === 'failed'
  const now = await $.clock.now()
  const lines: string[] = []
  for (const agent of state.agents) {
    const key = `${agent.name}@${agent.startedAt}@${agent.status}`
    if (reminded.has(key)) continue
    const id = agent.name.toLowerCase()
    let line = ''
    if (agent.status === 'in_review' && runningNow(agent.name, now)) {
      // Its session is running again (a queued brief): it is not waiting on the orchestrator.
      continue
    } else if (agent.status === 'in_review') {
      line = `${agent.name} is still In review. Accept it (mc.py accept ${id}, or the report tool's accept) or send it back (mc.py sendback ${id} --task "..."), or say why it is still under review.`
    } else if (agent.status === 'working' && finished) {
      line = `${agent.name} still shows working on a finished task. Accept it, set it idle, or say why.`
    }
    if (!line) continue
    reminded.add(key)
    lines.push(line)
  }
  return lines.length > 0 ? `Mission Control: ${lines.join(' ')} Do it before you finish.` : null
}

// ---- the session watch: a helper's session that has finished its turn -----------------------------

/**
 * The backstop when a helper ends without its report line. The app delivers a helper's result to the
 * orchestrator only when the orchestrator's next turn starts, and starts that turn only when no
 * session it started is still working; so the orchestrator's own session cannot be relied on to
 * notice. The desktop app keeps a record of each session it runs, `claude-code-sessions/…/
 * local_<id>.json` in its data folder (macOS: ~/Library/Application Support/Claude; Windows:
 * %APPDATA%/Claude), which it rewrites as a session's turns start and end. That record is the app's
 * own and undocumented, so this is a best effort, read only, and can be switched off
 * (`/mission watch off`). Only the known helpers' records are read, and from each only its id, title,
 * working folder, transcript id, last activity and whether its last turn has ended. A record's session counts as
 * finished when its last turn has its summary (`postTurnSummaryFor` is its last answer) and nothing
 * the person or a peer sent came after that turn's end.
 */
const STORE_WATCH = 'watch'
let watchOn = true
let watchTimer: { cancel: () => void } | null = null
/** Each record seen: when it last changed, and what it said. */
const seenRecords = new Map<string, { mtime: number; info: SessionRecord | null }>()

type SessionRecord = {
  id: string
  title: string
  finished: boolean
  turnEndedAt: number
  /** The transcript's id: the session the last answer came from, else the record's own. */
  transcriptId: string
  cwd: string
  activeAt: number
}

/** What a session record says (only these fields are taken), or null when it is not one. */
export function recordOf(text: string): SessionRecord | null {
  let d: Record<string, unknown>
  try {
    d = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof d.sessionId !== 'string') return null
  const edge = typeof d.lastTurnEdgeAt === 'number' ? d.lastTurnEdgeAt : 0
  const userFrame = typeof d.latestUserFrameAt === 'number' ? d.latestUserFrameAt : 0
  const finished = typeof d.lastAssistantUuid === 'string' && d.postTurnSummaryFor === d.lastAssistantUuid && userFrame < edge
  return {
    id: d.sessionId,
    title: typeof d.title === 'string' ? d.title : '',
    finished,
    turnEndedAt: edge,
    transcriptId: [d.lastAssistantCliSessionId, d.cliSessionId].find((each): each is string => typeof each === 'string' && /^[\w-]+$/.test(each)) ?? '',
    cwd: typeof d.cwd === 'string' ? d.cwd : '',
    activeAt: typeof d.lastActivityAt === 'number' ? d.lastActivityAt : edge,
  }
}

/** The app's folder of session records on this machine, or null where it keeps none. */
async function recordsRoot($: EngineInterface): Promise<string | null> {
  const home = ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '').replace(/\\/g, '/')
  const appData = ((await $.env.get('APPDATA')) || '').replace(/\\/g, '/')
  const places = [appData ? `${appData}/Claude/claude-code-sessions` : '', home ? `${home}/Library/Application Support/Claude/claude-code-sessions` : '']
  for (const place of places) if (place && (await $.fs.exists(place).catch(() => false))) return place
  return null
}

/** The helper sessions this orchestrator knows, by the app's id: learned from its own notes, or mapped by hand. */
function helperIds(): string[] {
  const ids = new Set<string>()
  for (const id of titles.keys()) if (/^local_[\w-]+$/.test(id) && roleFor(id) !== null) ids.add(id)
  for (const pattern of Object.values(explicit)) if (/^local_[\w-]+$/.test(pattern.trim())) ids.add(pattern.trim())
  return [...ids]
}

/** Where each helper's record is, once found (its file is `<root>/<account>/<org>/<id>.json`). */
const recordPaths = new Map<string, string>()

async function recordPathOf($: EngineInterface, root: string, id: string): Promise<string> {
  const known = recordPaths.get(id)
  if (known) return known
  for (const one of await $.fs.list(root).catch(() => [])) {
    if (one.kind !== 'dir') continue
    for (const two of await $.fs.list(`${root}/${one.name}`).catch(() => [])) {
      const path = `${root}/${one.name}/${two.name}/${id}.json`
      if (two.kind === 'dir' && (await $.fs.exists(path).catch(() => false))) {
        recordPaths.set(id, path)
        return path
      }
    }
  }
  return ''
}

/**
 * Reads the records of the known helpers only (no other session's), when they change; follows
 * their transcripts; and, for a helper whose transcript is not found, hands it in when its record
 * says its turn has ended.
 */
async function watchSessions($: EngineInterface): Promise<void> {
  if (!watchOn || !enabled || !orchestrating || helperRole) return
  const root = await recordsRoot($)
  const infos: SessionRecord[] = []
  for (const id of root ? helperIds() : []) {
    const path = await recordPathOf($, root ?? '', id)
    if (!path) continue
    const stat = await $.fs.stat(path).catch(() => null)
    if (!stat) continue
    const known = seenRecords.get(path)
    if (!known || known.mtime !== stat.mtimeMs) seenRecords.set(path, { mtime: stat.mtimeMs, info: recordOf(await $.fs.read(path).catch(() => '')) })
    const info = seenRecords.get(path)?.info
    if (info) infos.push(info)
  }
  await followFrom($, infos)
  // Each helper's role under its transcript id, so the helper's own plugin knows which card is its own.
  const roles = Object.fromEntries(infos.flatMap(info => (info.transcriptId && roleFor(info.id) ? [[info.transcriptId, roleFor(info.id) ?? '']] : [])))
  if (Object.keys(roles).length > 0) await recordRoles($, roles).catch(() => undefined)
  for (const info of infos) {
    const role = roleFor(info.id)
    // A helper whose transcript is followed is handed in from it, not from its record.
    if (!role || !info.finished || followed.get(role)?.turn) continue
    const own = await ownReports($)
    await report($, (state: McState): Report[] => {
      const agent = state.agents.find(each => each.name.toLowerCase() === role.toLowerCase())
      // Only a card still working on a job its session has since finished.
      if (agent?.status !== 'working' || info.turnEndedAt <= agent.startedAt) return []
      const { line, task } = handedIn(own, role)
      return [
        { do: 'event', type: 'report', from: idOf(role), to: 'orchestrator', text: line, auto: true },
        { do: 'agent', name: role, status: 'in_review', task },
      ]
    }).catch(() => undefined)
  }
}

/**
 * Following each helper's transcript: the source of truth for its card. Every second, each
 * followed transcript's change time is looked at; when it has moved, the end of the file is read
 * (the last 256 KB, by `tail`, or PowerShell on Windows) and the turn read from it (transcript.ts).
 * From that, with nobody writing anything: a running turn shows the agent working (never anything
 * else, unless it waits on the person), timed from the turn's start; a turn that ended after the
 * agent's job began shows it in review with its own report line, else "Handed in" (handedIn). Done, queued and
 * idle stay the orchestrator's to set; needs-you comes from the helper's own permission prompt.
 */
type Followed = { path: string; mtime: number; turn: Turn | null }
/** A transcript unchanged this long is not running, whatever its last line says (a crashed session). */
export const QUIET_MS = 10 * 60_000
const NOT_RUNNING = 'Not running: last seen '
const followed = new Map<string, Followed>()
let followTimer: { cancel: () => void } | null = null
/** Transcripts found by searching every project folder, by transcript id. */
const foundPaths = new Map<string, string>()

/** Claude Code's own folder: CLAUDE_CONFIG_DIR, else `<home>/.claude`. */
async function configDir($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config) return config.replace(/\\/g, '/').replace(/\/+$/, '')
  const home = ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return home ? `${home}/.claude` : ''
}

/** A session's transcript: where its working folder puts it, else wherever a project folder holds it. */
async function transcriptOf($: EngineInterface, info: SessionRecord): Promise<string> {
  const root = await configDir($)
  if (!root || !info.transcriptId) return ''
  const direct = `${root}/projects/${projectFolderOf(info.cwd)}/${info.transcriptId}.jsonl`
  if (info.cwd && (await $.fs.exists(direct).catch(() => false))) return direct
  const known = foundPaths.get(info.transcriptId)
  if (known !== undefined) return known
  let found = ''
  for (const folder of await $.fs.list(`${root}/projects`).catch(() => [])) {
    if (folder.kind !== 'dir') continue
    const path = `${root}/projects/${folder.name}/${info.transcriptId}.jsonl`
    if (await $.fs.exists(path).catch(() => false)) {
      found = path
      break
    }
  }
  foundPaths.set(info.transcriptId, found)
  return found
}

/** Picks each role's session (its own helpers first, then the most recently active) and its transcript. */
async function followFrom($: EngineInterface, infos: SessionRecord[]): Promise<void> {
  const best = new Map<string, SessionRecord>()
  const rank = (info: SessionRecord) => info.activeAt
  for (const info of infos) {
    const role = roleFor(info.id)
    if (!role) continue
    const held = best.get(role)
    if (!held || rank(info) > rank(held)) best.set(role, info)
  }
  for (const [role, info] of best) {
    // A mapping may name a transcript file itself.
    const named = explicit[role]?.trim() ?? ''
    const path = named.endsWith('.jsonl') ? named.replace(/\\/g, '/') : await transcriptOf($, info)
    if (!path) continue
    if (followed.get(role)?.path !== path) followed.set(role, { path, mtime: -1, turn: null })
  }
  // A role mapped by hand to a transcript path, or to a worktree's name (its transcripts' folder ends
  // with it; the newest there is followed), with no record of its own: a terminal session, say.
  for (const [role, pattern] of Object.entries(explicit)) {
    if (best.has(role)) continue
    const named = pattern.trim().replace(/\\/g, '/')
    const path = named.endsWith('.jsonl') ? named : /^[\w.-]{6,}$/.test(named) && !named.startsWith('local_') ? await newestIn($, named) : ''
    if (path && followed.get(role)?.path !== path) followed.set(role, { path, mtime: -1, turn: null })
  }
}

/** The newest transcript in the project folder whose name ends with a worktree's name, or ''. */
async function newestIn($: EngineInterface, worktree: string): Promise<string> {
  const root = await configDir($)
  if (!root) return ''
  const end = `-${projectFolderOf(worktree)}`
  const folder = (await $.fs.list(`${root}/projects`).catch(() => [])).find(each => each.kind === 'dir' && each.name.endsWith(end))
  if (!folder) return ''
  const newest = (await $.fs.list(`${root}/projects/${folder.name}`).catch(() => []))
    .filter(each => each.kind === 'file' && each.name.endsWith('.jsonl'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  return newest ? `${root}/projects/${folder.name}/${newest.name}` : ''
}

/** How much of a transcript's end is read: never more. */
export const TAIL_BYTES = 262_144

/** The last `bytes` of a file, through the host's own tools: `tail`, or PowerShell on Windows. */
export async function tailOf($: EngineInterface, path: string, bytes: number): Promise<string> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = windows
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', `$s=[IO.File]::Open('${path.replace(/'/g, "''")}','Open','Read','ReadWrite');$n=[Math]::Min($s.Length,${bytes});$null=$s.Seek(-$n,'End');$b=New-Object byte[] $n;$null=$s.Read($b,0,$n);$s.Close();[Console]::OpenStandardOutput().Write($b,0,$n)`]
    : ['tail', '-c', String(bytes), '--', path]
  const result = await $.process.run(argv, { timeoutMs: 5000 })
  return result.exitCode === 0 ? result.stdout : ''
}

/** One look at every followed transcript, and one write for whatever their cards should now show. */
async function followTranscripts($: EngineInterface, force = false): Promise<void> {
  if (!watchOn || !enabled || !orchestrating || helperRole || followed.size === 0) return
  let moved = false
  for (const follow of followed.values()) {
    const stat = await $.fs.stat(follow.path).catch(() => null)
    if (!stat || stat.mtimeMs === follow.mtime) continue
    follow.mtime = stat.mtimeMs
    // Only the last 256 KB. When that holds no whole entry of a turn (one very long line), the card
    // is left as it was until the file moves again.
    const turn = turnOf(await tailOf($, follow.path, TAIL_BYTES).catch(() => ''))
    if (turn.state === 'unknown') continue
    follow.turn = turn
    moved = true
  }
  // While a call waits for its result, look every second: the guess is due 10 seconds after it.
  const pending = [...followed.values()].some(follow => follow.turn?.pending)
  if (!moved && !force && !pending && !followTick()) return
  const now = await $.clock.now()
  // The log is read only when some card is to change (it may be up to 512 KB).
  const { state: STATE_FILE } = await pathsOf($)
  const current = parseState((STATE_FILE && (await readIfThere($, STATE_FILE))) || '')
  if (!current || cardChanges(current, now, EMPTY_LOG).length === 0) return
  const log = await logged($)
  await report($, (state: McState): Report[] => cardChanges(state, now, log))
}

type Brief = { text: string; other: boolean; at: number }
/**
 * From the log: each agent's own report line for its current job, the last brief it was given, and,
 * when the current task is finished or failed (`closed`), the agents already accepted for it.
 */
type Logged = { own: Map<string, string>; reportedAt: Map<string, number>; briefs: Map<string, Brief>; closed: boolean; accepted: Set<string> }
const EMPTY_LOG: Logged = { own: new Map(), reportedAt: new Map(), briefs: new Map(), closed: false, accepted: new Set() }
/** An agent accepted for a task that is already over: its late turn end or report changes nothing. */
const settledFor = (log: Logged, role: string): boolean => log.closed && log.accepted.has(role.toLowerCase())
/**
 * How long a tool call may wait for its result before the panel guesses its helper is stopped on a
 * permission prompt (with no plugin in the helper's session, a prompt leaves nothing else to see).
 */
export const PERMISSION_GUESS_MS = 10_000
const GUESS = 'May be waiting for your permission: '
/** Tool calls that run long on their own and never count as a stalled prompt: shell commands, subagents, skills, waits. */
export const runsLong = (name: string): boolean => /^(Bash|Agent|Task|Skill)$/.test(name) || /wait|sleep|monitor|agent|skill/i.test(name)

/** A card's line while its helper works on something other than the current task. */
const OTHER = 'Other task: '

/**
 * What each followed helper's card should become, from its transcript; [] when all are right.
 *
 * - A question to the person (its turn ended on a "next step" question, or a question tool waits
 *   for its answer): NEEDS YOU, with the question itself (80 characters), one needs_user event.
 * - Running: working, whatever the card said (in review or done included: a queued brief started
 *   it again), timed from the turn's start. Needs you stays only while nothing came after it was
 *   set (a permission prompt waits); a later entry is the answer, so working again. A brief for
 *   another task (marked side, or written under an earlier task) shows "Other task: …".
 * - Silent for QUIET_MS while running, with no question: not running ("Not running: last seen").
 * - Ended after its job began: in review with its own report line, or "Handed in"; ended on work
 *   for another task: idle, the report logged with the "other task" mark.
 */
function cardChanges(state: McState, now: number, log: Logged): Report[] {
  const updates: Report[] = []
  for (const [role, { turn, mtime }] of followed) {
    if (!turn) continue
    const agent = state.agents.find(each => each.name.toLowerCase() === role.toLowerCase())
    const brief = log.briefs.get(role.toLowerCase())
    const other = brief?.other === true
    // Accepted for a task that is already over: a late turn (its end, or running again) changes nothing.
    if (settledFor(log, role)) continue
    const waiting = turn.question && (turn.state === 'running' || (agent && turn.endedAt > agent.startedAt && agent.status !== 'done' && agent.status !== 'idle'))
    if (waiting) {
      const question = clip(turn.question, 80)
      if (agent?.status === 'needs_user' && agent.currentTask === question) continue
      updates.push(
        { do: 'event', type: 'needs_user', from: idOf(role), to: 'orchestrator', text: question, auto: true },
        { do: 'agent', name: role, status: 'needs_user', task: question },
      )
    } else if (turn.state === 'running' && turn.pending?.name && !runsLong(turn.pending.name) && now - turn.pending.at > PERMISSION_GUESS_MS && (agent?.status === 'working' || agent?.status === 'needs_user')) {
      // A call that should have its result by now: likely a permission prompt. Only over working (or
      // its own earlier guess): never over the helper's own NEEDS YOU, a question, in review or done.
      const guess = clip(`${GUESS}${turn.pending.name.replace(/^mcp__.+?__/, '')}`, 80)
      if (agent.status === 'needs_user') continue
      updates.push(
        { do: 'event', type: 'needs_user', from: idOf(role), to: 'orchestrator', text: guess, auto: true },
        { do: 'agent', name: role, status: 'needs_user', task: guess },
      )
    } else if (turn.state === 'running' && now - mtime > QUIET_MS) {
      // Running by its last line, but silent for 10 minutes: not running. Its card says when it
      // was last seen, and its next line makes it working again.
      if (agent?.status === 'working') updates.push({ do: 'agent', name: role, status: 'idle', task: `${NOT_RUNNING}${clockOf(mtime)}` })
    } else if (turn.state === 'running') {
      const line = brief ? `${other ? OTHER : ''}${brief.text}` : 'Back at work'
      if (agent?.status === 'working') {
        // Already working: only its line follows a brief for another task, so it cannot mislead.
        if (other && !agent.currentTask.startsWith(OTHER)) updates.push({ do: 'agent', name: role, status: 'working', task: clip(line, 80) })
        continue
      }
      // A question (or a permission prompt) stays until something is written after it was set.
      if (agent?.status === 'needs_user' && turn.lastAt <= agent.startedAt) continue
      // Handed in (or accepted) for its job, and the turn still running is the one in which it wrote
      // its report line: no new work until a turn begun after that line, or a brief sent after it.
      const reported = log.reportedAt.get(role.toLowerCase()) ?? 0
      if (agent && (agent.status === 'in_review' || agent.status === 'done') && reported >= turn.startedAt && !(brief && brief.at > reported)) continue
      // A queued or idle card keeps the task the orchestrator gave it (not this watch's own "Not
      // running"); one coming back from a hand-in or an answer takes the last brief it was given.
      const given = agent?.currentTask ?? ''
      const keep = !other && (agent?.status === 'queued' || agent?.status === 'idle') && given !== '' && !given.startsWith(NOT_RUNNING)
      updates.push({ do: 'agent', name: role, status: 'working', ...(keep ? {} : { task: clip(line, 80) }), ...(turn.startedAt > 0 ? { since: turn.startedAt } : {}) })
    } else if (agent && (agent.status === 'working' || agent.status === 'needs_user') && turn.endedAt > agent.startedAt) {
      if (other) {
        // Work for another task ends: logged with its mark, and the card here is idle again.
        updates.push(
          { do: 'event', type: 'report', from: idOf(role), to: 'orchestrator', text: log.own.get(role.toLowerCase()) ?? 'Handed in', auto: true, side: true },
          { do: 'agent', name: role, status: 'idle' },
        )
        continue
      }
      const { line, task } = handedIn(log.own, role)
      updates.push(
        { do: 'event', type: 'report', from: idOf(role), to: 'orchestrator', text: line, auto: true },
        { do: 'agent', name: role, status: 'in_review', task },
      )
    }
  }
  return updates
}

/**
 * Each agent's own report line for its current job: the last report it wrote itself (not an
 * automatic one) after the last dispatch to it, by lower-case name.
 */
async function ownReports($: EngineInterface): Promise<Map<string, string>> {
  return (await logged($)).own
}

/** From the log: each agent's own report line for its current job, and the last brief it was given. */
async function logged($: EngineInterface): Promise<Logged> {
  const { events } = await pathsOf($)
  const log = events ? await readIfThere($, events) : null
  const lines = new Map<string, string>()
  const reportedAt = new Map<string, number>()
  const briefs = new Map<string, Brief>()
  const { state: STATE_FILE } = await pathsOf($)
  const task = parseState((STATE_FILE && (await readIfThere($, STATE_FILE))) || '')?.task
  const current = task?.id
  const closed = task?.status === 'done' || task?.status === 'failed'
  const accepted = new Set<string>()
  for (const raw of (log ?? '').split('\n')) {
    let event: { type?: unknown; from?: unknown; to?: unknown; text?: unknown; auto?: unknown; side?: unknown; taskId?: unknown; time?: unknown }
    try {
      event = JSON.parse(raw) as typeof event
    } catch {
      continue
    }
    if (event.type === 'dispatch') {
      lines.delete(String(event.to ?? '').toLowerCase())
      reportedAt.delete(String(event.to ?? '').toLowerCase())
      // A brief marked side, or written under a task other than the current one, is other work.
      const other = event.side === true || (typeof event.taskId === 'string' && event.taskId !== current)
      if (typeof event.text === 'string') briefs.set(String(event.to ?? '').toLowerCase(), { text: event.text, other, at: Number(event.time) || 0 })
    } else if (event.type === 'report' && event.auto !== true && typeof event.text === 'string') {
      lines.set(String(event.from ?? '').toLowerCase(), event.text)
      reportedAt.set(String(event.from ?? '').toLowerCase(), Number(event.time) || 0)
    }
    else if (event.type === 'agent_done' && closed && event.taskId === current && event.side !== true) {
      // Accepted for this task: from the agent itself, or several in one "Accepted: A, B" line.
      const from = String(event.from ?? '').toLowerCase()
      const names = from === 'orchestrator' ? (/^Accepted: (.+)$/.exec(String(event.text ?? ''))?.[1]?.split(',') ?? []) : [from]
      for (const name of names) if (name.trim()) accepted.add(name.trim().toLowerCase())
    }
  }
  return { own: lines, reportedAt, briefs, closed, accepted }
}

/** Whether a helper's session is running now: its turn running, and its transcript changed in QUIET_MS. */
function runningNow(name: string, now: number): boolean {
  const follow = followed.get(roleName(name))
  return follow?.turn?.state === 'running' && now - follow.mtime <= QUIET_MS
}

/** A role's name as `followed` keys it: its first letter capitalised. */
const roleName = (name: string): string => `${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`

/** A time of day, hours and minutes, on this machine's clock. */
const clockOf = (time: number): string => new Date(time).toTimeString().slice(0, 5)

/** Every 10th look writes even when no transcript moved, so a card set wrongly by hand is put right. */
let ticks = 0
const followTick = (): boolean => ++ticks % 10 === 0

/** Starts the session watch (every 4 seconds), once per session. */
export function startWatch($: EngineInterface): void {
  watchTimer?.cancel()
  watchTimer = $.clock.every(4000, () => void watchSessions($).catch(() => undefined))
  followTimer?.cancel()
  followTimer = $.clock.every(1000, () => void follow($))
  // At once, not after the first 4 seconds: a reload (each time the orchestrator's turn ends) starts
  // with nothing followed, and a card set wrongly meanwhile would stay so.
  void watchSessions($)
    .then(() => follow($, true))
    .catch(() => undefined)
  // And right after any write of this plugin (an accept, a hand-in), so a running helper never shows done.
  afterWrite(() => void follow($, true))
  aliveTimer?.cancel()
  aliveTimer = $.clock.every(KEEP_ALIVE_MS, () => void keepAlive($).catch(() => undefined))
}

/** One follow at a time; a call meanwhile runs once more after it. */
let following: Promise<void> | null = null
let again = false
function follow($: EngineInterface, force = false): Promise<void> {
  if (following) {
    again = true
    return following
  }
  following = followTranscripts($, force || again)
    .catch(() => undefined)
    .finally(() => {
      following = null
      if (again) {
        again = false
        void follow($, true)
      }
    })
  return following
}

/**
 * The orchestrator's plugin is itself a sign of life: while a task runs, it marks the state fresh
 * this often, from its own clock, so the pane stays LIVE with no other process running. (It runs
 * while the session is idle too: the plugin's clock does not stop between turns.)
 */
const KEEP_ALIVE_MS = 20_000
let aliveTimer: { cancel: () => void } | null = null
async function keepAlive($: EngineInterface): Promise<void> {
  if (!orchestrating || helperRole) return
  await report($, (state: McState): Report[] => (state.task?.status === 'running' ? [{ do: 'heartbeat' }] : []))
}

/** `/mission auto on|off`, `/mission agents [role=pattern]`, `/mission role <role>|none`. */
export async function autoCommand($: EngineInterface, words: string[]): Promise<string | null> {
  const [verb, ...rest] = words
  // `/mission auto` alone is the theme (follow the app's); with on or off it is this switch.
  if (verb === 'auto' && (rest[0] === 'on' || rest[0] === 'off')) {
    enabled = rest[0] === 'on'
    await $.store.set(STORE_AUTO, enabled)
    return `Automatic reporting is ${enabled ? 'on' : 'off'}.`
  }
  if (verb === 'watch' && (rest[0] === 'on' || rest[0] === 'off')) {
    watchOn = rest[0] === 'on'
    await $.store.set(STORE_WATCH, watchOn)
    return `${titled()}: watching helper sessions for a finished turn is ${watchOn ? 'on' : 'off'}.`
  }
  if (verb === 'debug' && (rest[0] === 'on' || rest[0] === 'off')) {
    debug = rest[0] === 'on'
    await $.store.set(STORE_DEBUG, debug)
    if (debug) await trace($, { debug: 'on' })
    return `${titled()}: debug ${debug ? 'on: brief calls (name and input keys only) and notes go to .panel-debug.json' : 'off'}.`
  }
  if (verb === 'agents') {
    for (const pair of rest) {
      const [role, ...pattern] = pair.split('=')
      if (role && pattern.length > 0) {
        const name = clip(role, 24)
        const value = pattern.join('=').trim()
        if (value) explicit[`${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`] = value
        else delete explicit[`${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`]
      }
    }
    if (rest.length > 0) await $.store.set(STORE_ROLES, explicit)
    const list = Object.entries(explicit).map(([role, pattern]) => `${role} = ${pattern}`)
    const head = `${titled()}, automatic reporting ${enabled ? 'on' : 'off'}, debug ${debug ? 'on' : 'off'}.`
    const learned = [...titles.entries()].filter(([id]) => id.startsWith('local_')).map(([id, title]) => `${roleFor(id) ?? '?'} = ${id} (${title})`)
    return `${head} ${list.length > 0 ? `Agents: ${list.join('; ')}.` : 'Agents: a session or agent whose title, handle or type holds Explorer, Worker, Tester or Security.'}${learned.length > 0 ? ` Learned: ${learned.join('; ')}.` : ''}`
  }
  if (verb === 'role') {
    const want = rest[0] ?? ''
    helperRole = want && want !== 'none' ? `${want[0]?.toUpperCase() ?? ''}${want.slice(1)}` : null
    return helperRole ? `This session reports as the helper ${helperRole}.` : 'This session is not a helper.'
  }
  return null
}

