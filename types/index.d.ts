// Mission Control's data: what the orchestrator reports (state.json and events.jsonl), parsed by
// hooks/mission/model.ts and written by hooks/mission/writer.ts.
export type MissionView = 'overview' | 'activity'
export type MissionTheme = 'auto' | 'light' | 'dark'

export type TaskStatus = 'idle' | 'running' | 'paused' | 'done' | 'failed'
export type StepStatus = 'pending' | 'active' | 'done' | 'skipped'
export type AgentStatus = 'idle' | 'queued' | 'working' | 'in_review' | 'done' | 'needs_user'
export type OrchStatus = 'idle' | 'planning' | 'dispatching' | 'working' | 'waiting' | 'reviewing' | 'needs_user' | 'done'
export type EventType =
  | 'dispatch'
  | 'report'
  | 'handoff'
  | 'agent_done'
  | 'needs_user'
  | 'plan_changed'
  | 'user_message'
  | 'task_started'
  | 'task_done'
  | 'task_failed'
  /** An agent's own line about its work, mid-job (written by the agent itself). */
  | 'progress'
  /** The orchestrator stopped the task on purpose, and took it up again. */
  | 'task_paused'
  | 'task_resumed'

export type McTask = {
  id: string
  title: string
  status: TaskStatus
  startedAt: number
  finishedAt?: number
  /** While paused: when, and why if the orchestrator said. */
  pausedAt?: number
  pauseReason?: string
}
export type McStep = { id: string; label: string; status: StepStatus }
export type McQueueItem = { id: string; text: string; receivedAt: number }
/** `taskId`: the task its state belongs to; a state of another task shows idle (absent in older files: the current task). */
export type McAgent = { id: string; name: string; status: AgentStatus; currentTask: string; startedAt: number; taskId?: string }
export type McState = {
  task: McTask | null
  plan: McStep[] | null
  queue: McQueueItem[]
  agents: McAgent[]
  /** `reviewing`: the agents whose reports it is reading, while its status is reviewing. */
  /**
   * `since`: when it last set its own status. `turn`: when its own turn began, while it runs (the
   * plugin, in its own session), and `turnLog` its session's transcript, where a pane reads whether
   * that turn has ended however it ended.
   */
  orchestrator: { status: OrchStatus; waitingOn: string[]; reviewing: string[]; since?: number; turn?: number; turnLog?: string }
  lastUpdated: number
}
export type McEvent = {
  time: number
  type: EventType
  from: string
  to: string
  text: string
  /** Written by the plugin's automatic reporting: the orchestrator's own copy of it wins. */
  auto?: true
  /** The task that was current when it was written. */
  taskId?: string
  /** Work for something other than the current task (the orchestrator's `side` dispatch). */
  side?: true
}

/**
 * What the pane draws from, kept in the plugin's state: the last good state, the newest events,
 * the events this read brought (for one-shot packets), and whether the feed has gone quiet.
 */
export type MissionData = {
  loaded: boolean
  state: McState | null
  events: McEvent[]
  eventCount: number
  fresh: McEvent[]
  /** When each of `fresh` was read (its shot's start); absent, `readAt` for all. */
  freshAt?: number[]
  readAt: number
  offline: boolean
  /** The newest change time of state.json or events.jsonl the reader saw: a sign of life. */
  aliveAt?: number
  /**
   * When the current task has finished or failed: what each agent that took part in it did, by its
   * lower-case name (model.ts `resultsOf`), for its idle card. Absent otherwise.
   */
  results?: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      mission: Shaped<MissionData>
      missionView: MissionView
      missionTheme: MissionTheme
      missionCell: number
      /** Bumped to redraw once a replaced drawing's ghost is due to go. */
      missionSwap: number
      /** The terminal's text pane: ASCII glyphs on, off, or chosen from the terminal (auto). */
      missionAscii: 'auto' | 'on' | 'off'
      /** The second the terminal's timers show, while a task runs. */
      missionSecond: number
    }
  }
}
