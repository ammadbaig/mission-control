/**
 * The writer's rules, as pure functions: a report in, the next state and any event out. The
 * `report` tool (index.tsx) and the optional CLI (cli/mc.py) follow the same rules and limits, so
 * either can write the files the pane reads. No `$` here.
 */

import { ORCH_TURN_ONLY, type AgentStatus, type EventType, type McAgent, type McEvent, type McState, type McStep, type OrchStatus, type StepStatus } from './model'

export const TITLE_MAX = 80
export const TASK_MAX = 80
export const EVENT_TEXT_MAX = 100
export const QUEUE_TEXT_MAX = 120
export const STEP_MAX = 24
export const NAME_MAX = 24
/** Hard caps (the rules ask for 3 to 7 steps; these only stop runaway input). */
export const MAX_STEPS = 12
export const MAX_QUEUE = 50
export const MAX_AGENTS = 12
export const MAX_UPDATES = 50
/** Past this size events.jsonl keeps only its newest LOG_KEEP_LINES lines. */
export const LOG_ROTATE_BYTES = 512 * 1024
export const LOG_KEEP_LINES = 500

export const STEP_STATUSES: StepStatus[] = ['pending', 'active', 'done', 'skipped']
export const AGENT_STATUSES: AgentStatus[] = ['idle', 'queued', 'working', 'in_review', 'done', 'needs_user']
export const ORCH_STATUSES: OrchStatus[] = ['idle', 'planning', 'dispatching', 'working', 'waiting', 'reviewing', 'needs_user', 'done']
export const EVENT_TYPES: EventType[] = [
  'dispatch',
  'report',
  'handoff',
  'agent_done',
  'needs_user',
  'plan_changed',
  'user_message',
  'task_started',
  'task_done',
  'task_failed',
  'progress',
  'task_paused',
  'task_resumed',
]

/** What one report asks for: `do` names it, the other fields are its arguments. */
export type Report = {
  do: string
  /** agent, from the plugin only: when the new status began (a helper's turn start), if before now. */
  since?: number
  title?: string
  steps?: string[]
  step?: string | number
  status?: string
  name?: string
  task?: string
  text?: string
  index?: number
  waitingOn?: string[]
  reviewing?: string[]
  /** task.pause: why, in plain words. */
  reason?: string
  type?: string
  from?: string
  to?: string
  /** Set by automatic reporting: the event is marked, and the orchestrator's own copy wins. */
  auto?: boolean
  /** event: work for something other than the current task (shown with an "other task" mark). */
  side?: boolean
}

export const REPORT_KINDS = [
  'task.start',
  'task.done',
  'task.fail',
  'task.pause',
  'task.resume',
  'plan.set',
  'plan.step',
  'plan.clear',
  'queue.add',
  'queue.promote',
  'queue.remove',
  'queue.clear',
  'agent',
  'orch',
  'event',
  'heartbeat',
  'say',
  'accept',
  'sendback',
] as const

/** The event types a helper may add about its own work, and nothing else. */
export const SAY_TYPES = ['progress', 'report'] as const
/** At most one progress line per agent this often; extras are dropped without a word. */
export const PROGRESS_GAP_MS = 5000

/** A name as events carry it: its lower-case id (the pane capitalises it when it draws). */
export const idOf = (name: unknown): string => clip(name, NAME_MAX).toLowerCase()

/** Names a helper may not say as: the orchestrator's and the person's. */
export const RESERVED_ROLES = new Set(['orchestrator', 'owner', 'person', 'user'])

/** A helper's role as it is written: its first letter capitalised ("tester" is "Tester"). */
export const roleName = (name: unknown): string => {
  const one = clip(name, NAME_MAX)
  return one ? `${one[0]?.toUpperCase() ?? ''}${one.slice(1)}` : ''
}

/**
 * A helper's own line (`say`): a progress or report event from it, and nothing else. The caller
 * declares the role (`as`); the line is always from that role. Errors for anything else.
 */
export function sayEvent(as: unknown, report: Report, now: number): { event: McEvent } | { error: string } {
  const from = roleName(as)
  if (!from) return { error: 'say needs `as`: the helper\'s own role, such as "tester"' }
  if (RESERVED_ROLES.has(from.toLowerCase())) return { error: `say is for a helper: "${from}" is not a helper's role` }
  const type = report.type ?? 'progress'
  if (type !== 'progress' && type !== 'report') return { error: 'say adds only a progress or report line' }
  const words = clip(report.text, EVENT_TEXT_MAX)
  if (!words) return { error: 'say needs text' }
  return { event: { time: now, type, from: idOf(from), to: type === 'report' ? 'orchestrator' : idOf(report.to), text: words } }
}

/** Whether `event`, a progress line, comes within PROGRESS_GAP_MS of the same agent's last one in `log`. */
export function tooSoon(log: string, event: McEvent): boolean {
  if (event.type !== 'progress') return false
  const lines = log.split('\n')
  for (let index = lines.length - 1, seen = 0; index >= 0 && seen < 200; index--, seen++) {
    const line = lines[index]?.trim()
    if (!line) continue
    try {
      const earlier = JSON.parse(line) as Partial<McEvent>
      if (earlier.type === 'progress' && String(earlier.from).toLowerCase() === event.from.toLowerCase()) {
        return event.time - Number(earlier.time) < PROGRESS_GAP_MS
      }
    } catch {
      // A half-written line: skip it.
    }
  }
  return false
}

/** One line, at most `limit` characters (cut with an ellipsis). */
export function clip(text: unknown, limit: number): string {
  // Whitespace folded to single spaces first (tabs and newlines included), then any other control
  // character (C0, DEL, C1: escape sequences among them) dropped, so none reaches a file or a screen.
  const one = String(text ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  return one.length <= limit ? one : `${one.slice(0, limit - 1).trimEnd()}…`
}

export const emptyState = (now: number): McState => ({
  task: null,
  plan: null,
  queue: [],
  agents: [],
  orchestrator: { status: 'idle', waitingOn: [], reviewing: [] },
  lastUpdated: now,
})

const has = <T extends string>(allowed: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)

/** A step by its number from 1, or by its label or id (as cli/mc.py finds it). */
const findStep = (plan: McStep[], ref: string | number | undefined): McStep | string => {
  if (ref === undefined) return 'plan.step needs a step'
  const asText = String(ref).trim()
  if (/^\d+$/.test(asText)) {
    const number = Number(asText)
    return plan[number - 1] ?? `plan.step takes a number from 1 to ${plan.length}, or a label`
  }
  return plan.find(step => step.label.toLowerCase() === asText.toLowerCase() || step.id === asText) ?? `no step ${JSON.stringify(asText)}`
}

/**
 * A task starts or ends: every agent is idle with no words and no task, until the orchestrator says
 * otherwise (queued only for one it plans to use). Done is per task: nothing from one task stays on
 * a card under the next.
 */
const restAgents = (state: McState, now: number): void => {
  for (const agent of state.agents) {
    if (agent.status !== 'idle' || agent.currentTask) agent.startedAt = now
    agent.status = 'idle'
    agent.currentTask = ''
    delete agent.taskId
  }
}

/**
 * A task starts or ends: the orchestrator's own status starts over too (IDLE, or DONE after
 * task.done), so nothing it set under one task stays in the circle after it. Its turn is kept.
 */
const restOrchestrator = (state: McState, status: 'idle' | 'done', now: number): void => {
  state.orchestrator = { status, waitingOn: [], reviewing: [], since: now, ...turnOfOrch(state.orchestrator) }
}

/** The orchestrator's running turn, as its own writes keep it. */
const turnOfOrch = (orch: McState['orchestrator']): { turn?: number; turnLog?: string } => ({
  ...(orch.turn === undefined ? {} : { turn: orch.turn }),
  ...(orch.turnLog === undefined ? {} : { turnLog: orch.turnLog }),
})

/** An agent's state now belongs to the current task (or to none, when there is none). */
const ownTask = (state: McState, agent: McAgent): void => {
  if (state.task) agent.taskId = state.task.id
  else delete agent.taskId
}

export type Applied = { state: McState; event?: McEvent; error?: undefined } | { error: string }

/**
 * Applies one report to a copy of `state`. `now` stamps it and `id()` names a new task or queue
 * item. An error leaves the state as it was (the caller reports it and applies nothing more).
 */
export function apply(current: McState, report: Report, now: number, id: () => string): Applied {
  const state: McState = structuredClone(current)
  const kind = report.do

  switch (kind) {
    case 'task.start': {
      if (!report.title) return { error: 'task.start needs a title' }
      state.task = { id: id(), title: clip(report.title, TITLE_MAX), status: 'running', startedAt: now }
      restAgents(state, now)
      restOrchestrator(state, 'idle', now)
      state.lastUpdated = now
      // Logged by itself, so the task's card has a line of its own from the start (automatic: the
      // orchestrator's own copy, if it logs one, takes its place).
      return { state, event: { time: now, type: 'task_started', from: 'orchestrator', to: '', text: 'Started', auto: true } }
    }
    case 'task.done':
    case 'task.fail': {
      if (!state.task) return { error: 'there is no task' }
      state.task.status = kind === 'task.done' ? 'done' : 'failed'
      state.task.finishedAt = now
      if (kind === 'task.done' && state.plan) {
        for (const step of state.plan) if (step.status === 'active' || step.status === 'pending') step.status = 'done'
      }
      restAgents(state, now)
      restOrchestrator(state, kind === 'task.done' ? 'done' : 'idle', now)
      state.lastUpdated = now
      // The orchestrator's own task_done or task_failed for this task, before or after, replaces it.
      return {
        state,
        event:
          kind === 'task.done'
            ? { time: now, type: 'task_done', from: 'orchestrator', to: '', text: 'Finished', auto: true }
            : { time: now, type: 'task_failed', from: 'orchestrator', to: '', text: 'Failed', auto: true },
      }
    }
    case 'task.pause': {
      if (state.task?.status !== 'running') return { error: 'only a running task can be paused' }
      const why = clip(report.reason, EVENT_TEXT_MAX)
      state.task.status = 'paused'
      state.task.pausedAt = now
      if (why) state.task.pauseReason = why
      else delete state.task.pauseReason
      state.lastUpdated = now
      return { state, event: { time: now, type: 'task_paused', from: 'orchestrator', to: '', text: why ? `Paused: ${why}` : 'Paused' } }
    }
    case 'task.resume': {
      if (state.task?.status !== 'paused') return { error: 'the task is not paused' }
      state.task.status = 'running'
      delete state.task.pausedAt
      delete state.task.pauseReason
      // Going on answers the orchestrator's own question.
      if (state.orchestrator.status === 'needs_user') restOrchestrator(state, 'idle', now)
      state.lastUpdated = now
      return { state, event: { time: now, type: 'task_resumed', from: 'orchestrator', to: '', text: 'Resumed' } }
    }
    case 'plan.set': {
      const labels = (report.steps ?? []).map(label => clip(label, STEP_MAX)).filter(Boolean)
      if (labels.length === 0) return { error: 'plan.set needs steps, such as ["Find", "Fix", "Verify"]' }
      if (labels.length > MAX_STEPS) return { error: `a plan has at most ${MAX_STEPS} steps (3 to 7 is the guide)` }
      state.plan = labels.map((label, index) => ({ id: `s${index + 1}`, label, status: index === 0 ? 'active' : 'pending' }))
      break
    }
    case 'plan.clear': {
      state.plan = null
      break
    }
    case 'plan.step': {
      if (!state.plan) return { error: 'there is no plan' }
      if (!has(STEP_STATUSES, report.status)) return { error: `plan.step status must be one of: ${STEP_STATUSES.join(', ')}` }
      const step = findStep(state.plan, report.step)
      if (typeof step === 'string') return { error: step }
      // Exactly one step is active.
      if (report.status === 'active') for (const other of state.plan) if (other.status === 'active') other.status = 'done'
      step.status = report.status
      if ((report.status === 'done' || report.status === 'skipped') && !state.plan.some(other => other.status === 'active')) {
        const following = state.plan.find(other => other.status === 'pending')
        if (following) following.status = 'active'
      }
      break
    }
    case 'queue.add': {
      if (!report.text) return { error: 'queue.add needs text' }
      if (state.queue.length >= MAX_QUEUE) return { error: `the queue holds at most ${MAX_QUEUE} items` }
      state.queue.push({ id: id(), text: clip(report.text, QUEUE_TEXT_MAX), receivedAt: now })
      break
    }
    case 'queue.clear': {
      state.queue = []
      break
    }
    case 'queue.remove': {
      const index = report.index ?? 0
      if (!Number.isInteger(index) || index < 1 || index > state.queue.length) {
        return { error: `queue.remove needs an index from 1 to ${state.queue.length}` }
      }
      state.queue.splice(index - 1, 1)
      break
    }
    case 'queue.promote': {
      if (state.queue.length === 0) return { error: 'the queue is empty' }
      if (state.task?.status === 'running' || state.task?.status === 'paused') return { error: 'a task is still running: finish it with task.done or task.fail, then promote' }
      const item = state.queue.shift()
      if (!item) return { error: 'the queue is empty' }
      state.task = { id: item.id, title: clip(item.text, TITLE_MAX), status: 'running', startedAt: now }
      state.plan = null
      restAgents(state, now)
      restOrchestrator(state, 'idle', now)
      break
    }
    case 'agent': {
      if (!report.name) return { error: 'agent needs a name' }
      if (!has(AGENT_STATUSES, report.status)) return { error: `agent status must be one of: ${AGENT_STATUSES.join(', ')}` }
      const name = clip(report.name, NAME_MAX)
      if (!name) return { error: 'agent needs a name' }
      let agent = state.agents.find(other => other.name.toLowerCase() === name.toLowerCase())
      if (!agent) {
        if (state.agents.length >= MAX_AGENTS) return { error: `at most ${MAX_AGENTS} agents` }
        agent = { id: name.toLowerCase(), name, status: 'idle', currentTask: '', startedAt: now }
        state.agents.push(agent)
      }
      if (agent.status !== report.status) agent.startedAt = typeof report.since === 'number' && report.since > 0 && report.since <= now ? report.since : now
      ownTask(state, agent)
      agent.status = report.status
      if (report.task !== undefined) agent.currentTask = clip(report.task, TASK_MAX)
      // Idle with nothing said: no stale words from its last job stay on its card.
      else if (report.status === 'idle') agent.currentTask = ''
      break
    }
    case 'orch': {
      if (!has(ORCH_STATUSES, report.status)) return { error: `orch status must be one of: ${ORCH_STATUSES.join(', ')}` }
      const names = (list?: string[]) => (list ?? []).map(name => clip(name, NAME_MAX)).filter(Boolean).slice(0, MAX_AGENTS)
      // `reviewing` only while it reviews: whom it is reading the reports of.
      state.orchestrator = {
        status: report.status,
        waitingOn: names(report.waitingOn),
        reviewing: report.status === 'reviewing' ? names(report.reviewing) : [],
        since: now,
        ...turnOfOrch(state.orchestrator),
      }
      break
    }
    case 'accept': {
      // One step: done, agent_done logged, and out of the orchestrator's reviewing list.
      const all = report.name === undefined || report.name === '' || report.name.toLowerCase() === 'all'
      const chosen = all ? state.agents.filter(agent => agent.status === 'in_review') : state.agents.filter(agent => agent.name.toLowerCase() === clip(report.name, NAME_MAX).toLowerCase())
      if (chosen.length === 0) return { error: all ? 'no agent is in review' : `no agent ${JSON.stringify(report.name)}` }
      const note = clip(report.text, TASK_MAX)
      for (const agent of chosen) {
        agent.status = 'done'
        agent.startedAt = now
        if (note) agent.currentTask = note
        ownTask(state, agent)
      }
      const names = new Set(chosen.map(agent => agent.name.toLowerCase()))
      state.orchestrator.reviewing = state.orchestrator.reviewing.filter(name => !names.has(name.toLowerCase()))
      state.lastUpdated = now
      const first = chosen[0]
      return {
        state,
        event:
          chosen.length === 1 && first
            ? { time: now, type: 'agent_done', from: first.name.toLowerCase(), to: 'orchestrator', text: note || 'Accepted' }
            : { time: now, type: 'agent_done', from: 'orchestrator', to: '', text: note || `Accepted: ${chosen.map(agent => agent.name).join(', ')}` },
      }
    }
    case 'sendback': {
      // One step: back to working with what to fix, a dispatch logged, its timer restarted.
      const name = clip(report.name, NAME_MAX)
      const agent = state.agents.find(each => each.name.toLowerCase() === name.toLowerCase())
      if (!agent) return { error: `no agent ${JSON.stringify(report.name ?? '')}` }
      const task = clip(report.task, TASK_MAX)
      if (!task) return { error: 'sendback needs task: what to fix' }
      agent.status = 'working'
      agent.currentTask = task
      agent.startedAt = now
      ownTask(state, agent)
      state.orchestrator.reviewing = state.orchestrator.reviewing.filter(each => each.toLowerCase() !== name.toLowerCase())
      state.lastUpdated = now
      return { state, event: { time: now, type: 'dispatch', from: 'orchestrator', to: name.toLowerCase(), text: task } }
    }
    case 'event': {
      if (!has(EVENT_TYPES, report.type)) return { error: `event type must be one of: ${EVENT_TYPES.join(', ')}` }
      state.lastUpdated = now
      return {
        state,
        event: {
          time: now,
          type: report.type,
          from: idOf(report.from),
          to: idOf(report.to),
          text: clip(report.text, EVENT_TEXT_MAX),
          ...(report.auto ? { auto: true as const } : {}),
          ...(report.side ? { side: true as const } : {}),
        },
      }
    }
    case 'heartbeat':
      break
    case 'say':
      return { error: 'say is for a helper: call report with `as` set to your role' }
    default:
      return { error: `unknown report ${JSON.stringify(kind)}; one of: ${REPORT_KINDS.join(', ')}` }
  }
  state.lastUpdated = now
  return { state }
}

/**
 * The orchestrator's own turn begins (`open`) or ends: written by the plugin in the orchestrator's
 * session only, never through `report`. While it runs the circle shows WORKING (model.ts
 * `orchestratorOf`). A new turn drops a DONE from an earlier one; the end drops PLANNING,
 * DISPATCHING and WORKING, which last only for their turn. `log`: its session's transcript.
 */
export function turnState(current: McState, open: boolean, now: number, log = ''): McState {
  const state: McState = structuredClone(current)
  const orch = state.orchestrator
  if (open) {
    orch.turn = now
    if (log) orch.turnLog = log
    else delete orch.turnLog
    if (orch.status === 'done') Object.assign(orch, { status: 'idle', since: now })
  } else {
    Object.assign(state, endedTurn(state, now))
  }
  state.lastUpdated = now
  return state
}

/**
 * The state with the orchestrator's turn ended: no turn, and PLANNING, DISPATCHING or WORKING
 * dropped (NEEDS YOU and the rest stand). A pane draws this when the turn's transcript shows it
 * ended, however it ended, with nothing written; `lastUpdated` is left as it was.
 */
export function endedTurn(current: McState, now: number): McState {
  const state: McState = structuredClone(current)
  const orch = state.orchestrator
  delete orch.turn
  delete orch.turnLog
  if (ORCH_TURN_ONLY.has(orch.status)) Object.assign(orch, { status: 'idle', since: now })
  return state
}

/** The log with `lines` added, rotated past LOG_ROTATE_BYTES to its newest LOG_KEEP_LINES lines. */
export function appendLines(log: string, lines: string[]): string {
  const text = (log && !log.endsWith('\n') ? `${log}\n` : log) + lines.map(line => `${line}\n`).join('')
  if (new TextEncoder().encode(text).length <= LOG_ROTATE_BYTES) return text
  const kept = text.split('\n').filter(line => line.trim() !== '').slice(-LOG_KEEP_LINES)
  return kept.map(line => `${line}\n`).join('')
}

/** The state file's text: one object, ending in a newline. */
export const stateText = (state: McState): string => `${JSON.stringify(state, null, 1)}\n`
