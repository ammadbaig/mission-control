/**
 * The orchestrator's reporting contract (state.json and events.jsonl in ~/.claude/mission-control),
 * and tolerant parsers for it: unknown fields are ignored, a bad field takes its default, and a
 * file that doesn't parse gives `null` so the caller keeps the last good state.
 */

export type {
  AgentStatus,
  EventType,
  McAgent,
  McEvent,
  McQueueItem,
  McState,
  McStep,
  McTask,
  MissionData,
  OrchStatus,
  StepStatus,
  TaskStatus,
} from '../../types'
import type { AgentStatus, EventType, McEvent, McState, MissionData, OrchStatus, StepStatus, TaskStatus } from '../../types'

export const EMPTY_DATA: MissionData = {
  loaded: false,
  state: null,
  events: [],
  eventCount: 0,
  fresh: [],
  readAt: 0,
  offline: false,
  aliveAt: 0,
}

/** The feed is offline when nothing has been written for this long. */
export const OFFLINE_MS = 60_000
/** How many events the panel keeps (the Activity view shows them all). */
export const KEEP_EVENTS = 40

const TASK_STATUSES: TaskStatus[] = ['idle', 'running', 'paused', 'done', 'failed']
const STEP_STATUSES: StepStatus[] = ['pending', 'active', 'done', 'skipped']
const AGENT_STATUSES: AgentStatus[] = ['idle', 'queued', 'working', 'in_review', 'done', 'needs_user']
const ORCH_STATUSES: OrchStatus[] = ['idle', 'planning', 'dispatching', 'waiting', 'reviewing', 'needs_user', 'done']
const EVENT_TYPES: EventType[] = [
  'dispatch',
  'report',
  'handoff',
  'agent_done',
  'needs_user',
  'plan_changed',
  'user_message',
  'task_done',
  'task_failed',
  'progress',
  'task_paused',
  'task_resumed',
]

type Loose = Record<string, unknown>
const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** state.json's text as a state, or `null` when it isn't one (half-written, empty, not JSON). */
export function parseState(raw: string): McState | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(value)) return null
  const task = isObject(value.task)
    ? {
        id: str(value.task.id),
        title: str(value.task.title),
        status: oneOf(value.task.status, TASK_STATUSES, 'running'),
        startedAt: num(value.task.startedAt),
        ...(typeof value.task.finishedAt === 'number' ? { finishedAt: value.task.finishedAt } : {}),
        ...(typeof value.task.pausedAt === 'number' ? { pausedAt: value.task.pausedAt } : {}),
        ...(typeof value.task.pauseReason === 'string' ? { pauseReason: value.task.pauseReason } : {}),
      }
    : null
  const plan = Array.isArray(value.plan)
    ? value.plan.filter(isObject).map((step, index) => ({
        id: str(step.id, `s${index + 1}`),
        label: str(step.label, `Step ${index + 1}`),
        status: oneOf(step.status, STEP_STATUSES, 'pending'),
      }))
    : null
  const orchestrator = isObject(value.orchestrator) ? value.orchestrator : {}
  return {
    task,
    plan: plan && plan.length > 0 ? plan : null,
    queue: list(value.queue)
      .filter(isObject)
      .map((item, index) => ({ id: str(item.id, `q${index}`), text: str(item.text), receivedAt: num(item.receivedAt) })),
    // Done and every other status are per task: a state written under another task shows idle here.
    agents: list(value.agents)
      .filter(isObject)
      .map(agent => ({
        id: str(agent.id, str(agent.name)),
        name: str(agent.name, 'Agent'),
        status: oneOf(agent.status, AGENT_STATUSES, 'idle'),
        currentTask: str(agent.currentTask),
        startedAt: num(agent.startedAt),
        ...(typeof agent.taskId === 'string' && agent.taskId ? { taskId: agent.taskId } : {}),
      }))
      .map(agent => (agent.taskId !== undefined && agent.taskId !== task?.id ? { ...agent, status: 'idle' as const, currentTask: '' } : agent)),
    orchestrator: {
      status: oneOf(orchestrator.status, ORCH_STATUSES, 'idle'),
      waitingOn: list(orchestrator.waitingOn).filter((name): name is string => typeof name === 'string'),
      // Absent in state files written before reviewing existed.
      reviewing: list(orchestrator.reviewing).filter((name): name is string => typeof name === 'string'),
      // When the orchestrator last set its own status (absent in older files).
      ...(typeof orchestrator.since === 'number' ? { since: orchestrator.since } : {}),
    },
    lastUpdated: num(value.lastUpdated),
  }
}

/** One events.jsonl line as an event, or `null` (a bad line is skipped, never fatal). */
export function parseEvent(line: string): McEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(value)) return null
  const type = oneOf(value.type, EVENT_TYPES, 'report')
  return {
    time: num(value.time),
    type,
    from: str(value.from),
    to: str(value.to),
    text: str(value.text),
    ...(typeof value.taskId === 'string' && value.taskId ? { taskId: value.taskId } : {}),
    ...(value.side === true ? { side: true as const } : {}),
  }
}

/**
 * The log's complete lines from `offset` on (a character index), and where the next read starts:
 * a last line with no newline yet is half-written, so it is left for the next read.
 */
export function readNewLines(text: string, offset: number): { events: McEvent[]; next: number } {
  const start = offset > text.length ? 0 : offset
  const end = text.lastIndexOf('\n') + 1
  if (end <= start) return { events: [], next: start }
  const events = text
    .slice(start, end)
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(parseEvent)
    .filter((event): event is McEvent => event !== null)
  return { events, next: end }
}

/** An agent in review longer than this shows how long, so a forgotten review is never normal. */
export const REVIEW_STALE_MS = 120_000

/** The statuses the orchestrator sets itself; every other one is derived from its agents. */
export const ORCH_OWN: ReadonlySet<string> = new Set(['planning', 'dispatching', 'needs_user'])
/** The updates of one call are timed a millisecond apart: an agent's change in the same call is not "after". */
const SAME_CALL_MS = 64

/**
 * The orchestrator as its agents show it, one rule for both writers and the pane. Whom it waits
 * on is always the agents working, and whom it reviews the agents in review. Its status: its own
 * PLANNING, DISPATCHING or NEEDS YOU while no agent's state has changed since it set it; else
 * REVIEWING while any agent is in review, WAITING while any works, DONE for a finished task, else
 * IDLE (or what it set, while a task runs and no agent is busy).
 */
export function orchestratorOf(state: McState | null): McState['orchestrator'] {
  const orch = state?.orchestrator ?? { status: 'idle' as const, waitingOn: [], reviewing: [] }
  if (!state) return orch
  const reviewing = state.agents.filter(agent => agent.status === 'in_review').map(agent => agent.name)
  const waitingOn = state.agents.filter(agent => agent.status === 'working').map(agent => agent.name)
  const lastChange = Math.max(0, ...state.agents.map(agent => agent.startedAt))
  const since = orch.since === undefined ? {} : { since: orch.since }
  if (ORCH_OWN.has(orch.status) && orch.since !== undefined && orch.since + SAME_CALL_MS >= lastChange) return { status: orch.status, waitingOn, reviewing, ...since }
  if (reviewing.length > 0) return { status: 'reviewing', waitingOn, reviewing, ...since }
  if (waitingOn.length > 0) return { status: 'waiting', waitingOn, reviewing, ...since }
  const running = state.task?.status === 'running' || state.task?.status === 'paused'
  if (!running) return { status: orch.status === 'done' ? 'done' : 'idle', waitingOn, reviewing, ...since }
  // A running task with no agent busy: what it set, unless that was waiting or reviewing on no one.
  const status = orch.status === 'waiting' || orch.status === 'reviewing' ? 'idle' : orch.status
  return { status, waitingOn, reviewing, ...since }
}

/**
 * What changes with time alone in the pane: the minutes of each review past REVIEW_STALE_MS, and
 * whether the orchestrator's own status still stands. The reader redraws when it changes.
 */
export function clockKeyOf(state: McState | null, now: number): string {
  if (!state) return ''
  const minutes = state.agents
    .filter(agent => agent.status === 'in_review' && now - agent.startedAt > REVIEW_STALE_MS)
    .map(agent => `${agent.name}:${Math.floor((now - agent.startedAt) / 60_000)}`)
  return `${minutes.join(',')}|${orchestratorOf(state).status}`
}

/**
 * Whether there has been no sign of life for OFFLINE_MS: no write to the state (its lastUpdated)
 * and none to either file (`aliveAt`, the newest change time the reader saw): a helper's line, a
 * CLI write, the orchestrator plugin's own heartbeat.
 */
export const isStale = (state: McState | null, now: number, aliveAt = 0): boolean =>
  !state || now - Math.max(state.lastUpdated || 0, aliveAt) > OFFLINE_MS

/**
 * Whether the feed has gone quiet while it should not: a running task with nothing written for
 * OFFLINE_MS. A paused task is not expected to report, and no task at all is idle, not offline.
 */
export const isOffline = (state: McState | null, now: number, aliveAt = 0): boolean => state?.task?.status === 'running' && isStale(state, now, aliveAt)
