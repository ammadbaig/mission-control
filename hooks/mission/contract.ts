/**
 * The reporting contract as the model reads it: a short system-prompt section in every session
 * (prompt.compose), the `report` tool's description and input schema, and the full rules in the
 * plugin's skill (skills/mission-control/SKILL.md). Kept steady: the section is cached.
 */

import { AGENT_STATUSES, EVENT_TYPES, ORCH_STATUSES, REPORT_KINDS, STEP_STATUSES } from './writer'

/** The lists the text names, from the writer's own: so the contract cannot drift from what it accepts. */
const list = (items: readonly string[]): string => items.map(item => `\`${item}\``).join(', ')
const QUEUE_KINDS = REPORT_KINDS.filter(kind => kind.startsWith('queue.'))
const ORCH_OWN_STATUSES = ['planning', 'dispatching', 'working', 'needs_user'] as const

export const TOOL_NAME = 'report'
export const TOOL_FULL_NAME = 'mcp__mission-control__report'
export const SECTION_ID = 'mission-control:contract'

export const SECTION = `# Mission Control

The Mission Control pane shows the person what you and your helper agents are doing. It shows only what you report, so anything you do not report looks like nothing happened. When you hand pieces of a task to subagents or other sessions, or the person asks you to report to Mission Control, you are the orchestrator: report through the \`${TOOL_FULL_NAME}\` tool, several updates per call. If another session or agent gave you your work, you are a helper: never change the task, plan, queue or anyone's status, whatever the task. You may add short lines about your own work: call the tool with \`as\` set to your role (\`explorer\`, \`worker\`, \`tester\`, \`security\`, or the one you were given) and updates of \`do: "say"\` with \`text\`. Add one when you start a distinct step, find something or hit a problem (about 3 to 8 per job, never one per command), and, as your last action before your final message, one with \`type: "report"\` saying what you hand in. The report line is required. A line opening with Done, Finished, Handing in, PASS, FAIL, Final: or Report: counts as your report. Your own lines move only your own card: your report shows you in review at once; any other line while you are not working shows you working again.

- Task: \`task.start\` with a plain title (80 characters at most) before any work; \`task.done\` or \`task.fail\` at the end. When you stop on purpose before it is finished (waiting for the person, a break, a session ending), \`task.pause\` with a short \`reason\`, and \`task.resume\` when you go on; a paused task never shows as offline.
- Plan: before any work, \`plan.set\` with 3 to 7 steps of one or two words each, taken from the task itself, never a fixed pipeline. Exactly one step is active. Mark a step that is no longer needed \`skipped\`; never delete it. If the plan changes, set it again and send a \`plan_changed\` event saying why. For open-ended work send \`plan.clear\`; never invent steps.
- Queue: when the person writes while a task runs, decide first. A new task: \`queue.add\`. A change to the running task: apply it, update the plan if needed, and send a \`user_message\` event; do not queue it. When a task finishes and the queue is not empty, \`queue.promote\` and set a fresh plan. The queue updates: ${list(QUEUE_KINDS)}.
- Agents: \`agent\` with the agent's name, its status (${AGENT_STATUSES.join(', ')}) and one plain sentence (80 characters at most) on what it is doing now; update it whenever that changes. Set \`queued\` only for an agent you plan to use in this task, saying what it is waiting for; leave every other agent \`idle\` (every agent is idle when a task starts). When an agent or you need the person's approval or answer, set \`needs_user\` and put the exact question in \`task\`. Setting an agent \`idle\` without \`task\` clears its old words.
- Automatic (unless the person ran \`/mission auto off\`): the plugin itself logs each brief you send a helper (SendMessage, start_session, the Agent tool) as a dispatch with the agent working and you waiting, and each helper's result (the note when its session finishes a turn, or a subagent's answer) (and each helper session's turn ending, read from its transcript) as a report with the agent in review; it says the helper's own report line, else only "Handed in". A running helper session shows working by itself. Do not log those by hand. You still write the task, the plan, the queue, \`done\` or sent back, \`needs_user\` for your own questions, \`idle\` and \`paused\`. A helper session's own permission prompt shows as NEEDS YOU by itself when the plugin runs there too; if you see "Request from <helper> · Needs input" and its card does not show it, set \`needs_user\` with the question yourself.
- Per task: every status belongs to the current task. When a task ends or a new one starts, every agent is idle with no words (a paused task keeps them). For work that is not the current task, send the dispatch event with \`side: true\`: it is marked "other task" and never shows as this task's work.
- A helper's question: a helper that ends its turn on a next-step question, or waits on a question tool, shows NEEDS YOU with that question by itself, and working again once answered. Its question is waiting on the person, not on you.
- Briefs: every brief you give a helper includes, as a requirement, the line it uses to report its own progress and its final report line (the tool with \`as\` and \`say\`, or \`mc.py say --as <role> "..."\`).
- A helper's result: your FIRST action when it arrives is, in one call, \`agent\` with status \`in_review\` and one line of what it reported, and the \`report\` event if the helper did not add its own (you show as reviewing by yourself). In the same turn in which you read the report, accept it (\`accept\` with its \`name\`: done, \`agent_done\` logged) or send it back (\`sendback\` with \`name\` and \`task\`: working, a dispatch logged). Never set \`done\` before you have read the report. If you try to finish with an agent still in review, the plugin asks you once to settle it.
- Orchestrator: your status follows your agents and your own turn, in this order: needs_user until the person answers, you set another status, or a task starts, ends or resumes; reviewing while any agent is in review; while your own turn runs, working (or the planning or dispatching you set in this turn); waiting (on those working) while any works; done for 30 seconds after \`task.done\`; else idle. The plugin knows your turn: working needs nothing from you, and planning, dispatching and working are dropped when the turn ends; \`task.start\`, \`task.done\` and \`task.fail\` start your status over. Set only your own: \`orch\` with ${list(ORCH_OWN_STATUSES)}, which shows until an agent's state changes (needs_user until the person answers: no agent's change, accept or pause drops it). Whom you wait on and review is never written; it is read from the agents. (All statuses: ${ORCH_STATUSES.join(', ')}.)
- Events: one for every dispatch (you to an agent), report (an agent to you), handoff (agent to agent), agent_done, needs_user, plan_changed, user_message, task_done and task_failed (\`task.start\`, \`task.done\` and \`task.fail\` log task_started "Started", task_done "Finished" and task_failed "Failed" by themselves; your own task_done or task_failed with the useful detail replaces theirs; \`progress\` lines are the helpers' own; \`task_paused\` and \`task_resumed\` are logged by \`task.pause\` and \`task.resume\`). All event types: ${list(EVENT_TYPES)}; one plain sentence (100 characters at most) with the useful detail: a commit, a branch, a number.
- Heartbeat: while your task runs the plugin keeps the pane LIVE; there is nothing to send (the \`heartbeat\` update is for scripts).

The full rules, with examples, are in the mission-control skill.`

export const TOOL_DESCRIPTION = `Reports to the Mission Control pane what the orchestrator and its agents are doing: the task, its plan, the queue, each agent's status, the orchestrator's status, and an event for every dispatch and report. Send several updates in one call, in order; they stop at the first that fails. A helper calls it with \`as\` set to its own role and only \`say\` updates: a progress line about its own work, or its report line when it hands in; it can change nothing else. Writes <home>/.claude/mission-control/state.json and events.jsonl.`

const text = (description: string) => ({ type: 'string', description })

export const TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    as: text('Only for a helper: your own role (explorer, worker, tester, security, or the one you were given). With it, every update must be do: "say".'),
    updates: {
      type: 'array',
      minItems: 1,
      description: 'The updates, applied in order.',
      items: {
        type: 'object',
        properties: {
          do: { type: 'string', enum: [...REPORT_KINDS], description: 'What to report.' },
          title: text('task.start: the task in plain words, 80 characters at most.'),
          reason: text('task.pause: why it stopped, in plain words (optional).'),
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'plan.set: 3 to 7 steps of one or two words, from the task itself. The first is active.',
          },
          step: { type: ['string', 'integer'], description: 'plan.step: the step, by label or by number from 1.' },
          status: {
            type: 'string',
            enum: [...new Set([...STEP_STATUSES, ...AGENT_STATUSES, ...ORCH_STATUSES])],
            description: `plan.step: ${STEP_STATUSES.join('|')}. agent: ${AGENT_STATUSES.join('|')}. orch: ${ORCH_OWN_STATUSES.join('|')} (the rest follow the agents and your turn).`,
          },
          name: text('agent: the agent, such as Explorer, Worker, Tester or Security.'),
          task: text('agent: what it is doing now, one plain sentence of 80 characters at most; for queued, what it waits for; for needs_user, the exact question; optional for idle.'),
          text: text('queue.add: the new task. event and say: one plain sentence of 100 characters at most.'),
          index: { type: 'integer', minimum: 1, description: 'queue.remove: the item, by number from 1.' },
          waitingOn: { type: 'array', items: { type: 'string' }, description: 'orch: ignored; whom it waits on is read from the agents working.' },
          reviewing: { type: 'array', items: { type: 'string' }, description: 'orch: ignored; whom it reviews is read from the agents in review.' },
          type: { type: 'string', enum: [...EVENT_TYPES], description: 'event: its type. say: progress (the default) or report.' },
          from: text('event: who sent it (orchestrator, or an agent); written as a lower-case id.'),
          to: text('event: who it is for.'),
          side: { type: 'boolean', description: 'event (a dispatch): work for something other than the current task. It is logged with an "other task" mark and never shows as this task\'s work.' },
        },
        required: ['do'],
      },
    },
  },
  required: ['updates'],
}
