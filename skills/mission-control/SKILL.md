---
name: mission-control
description: The full reporting rules for the Mission Control pane, with examples. Use when you orchestrate a task with more than one step or dispatch subagents or other sessions, so the pane shows the task, its plan, the queue, each agent and every dispatch and report.
---

# Reporting to Mission Control

The Mission Control pane shows the person what the orchestrator and its helper agents are doing. It reads only what is reported, so work that is not reported looks like nothing happened: no silent work.

The session that plans the work and hands its pieces to subagents or other sessions is the orchestrator. It owns the task, the plan, the queue, every agent's status and its own events. A session or subagent that was given its work by another one is a helper: it never changes the task, the plan, the queue or anyone's status, whatever the task, since that would overwrite the orchestrator's. It may add short lines about its own work, which the pane shows under its name.

## A helper's own lines

A helper calls the tool with `as` set to its own role and only `say` updates. The plugin refuses anything else from it.

```json
{ "as": "tester", "updates": [{ "do": "say", "text": "Running the visual tests: 3 of 20 done" }] }
```

Without the tool, the same from a shell: `python3 cli/mc.py say --as tester "Running the visual tests: 3 of 20 done"`.

- Add a line when you start a distinct step, find something, or hit a problem: about 3 to 8 per job, never one per command. Each is one plain sentence of 100 characters at most.
- As your last action before your final message, always add one line with `"type": "report"` (`--report` on the CLI) saying what you hand in; it is required. A plain line that opens with Done, Finished, Handing in, PASS or FAIL (any case), or with Final or Report followed straight away by `:`, `-`, `–` or `—` ("Final: PASS"; a bare "Final" or "Final check: …" is a progress line), while you are working counts as that report too. It moves your own card to `in_review` at once, with that line, whether or not the orchestrator is awake; the orchestrator then accepts it (`done`) or sends it back.
- Any other line while your card is not `working` (queued, idle, in review, done) means you have started a job: your card shows `working` again, its timer restarts, and the line is your task (queued or idle keep the orchestrator's task). Your lines never change the task, the plan, the queue, another agent or the orchestrator.
- A second progress line from the same agent within 5 seconds is dropped without a word.

The orchestrator puts that one line in every brief it gives a helper, with the helper's role filled in.

Report with the `mcp__mission-control__report` tool. Each call takes a list of updates, applied in order; the list stops at the first update that fails, and the tool says which.

```json
{ "updates": [
  { "do": "task.start", "title": "Fix the header that grows on the way back" },
  { "do": "plan.set", "steps": ["Find", "Fix", "Verify"] },
  { "do": "orch", "status": "planning" }
] }
```

Without the plugin's tool (a script, another tool), the same updates can be written with the optional command-line writer in the plugin's `cli/mc.py`. It needs Python 3.

## The task

- Before any work: `task.start` with a title in plain words, 80 characters at most.
- At the end: `task.done`, or `task.fail` if it could not be finished.
- While the task runs, the plugin keeps the pane LIVE by itself. There is nothing to send for that. Nothing needs starting: no heartbeat process. (The `heartbeat` update is for scripts that report without the plugin.) If nothing is reported for a minute after the session ends, the pane shows OFFLINE.

## What the plugin writes by itself

Automatic reporting is on unless the person ran `/mission auto off`:

- When you brief a helper (SendMessage, `start_session`, or the Agent tool for a subagent), the plugin logs the dispatch (the message's summary or first line, never the whole message), sets that agent `working` with it, and sets you `waiting` on it.
- When a helper's result arrives (the note the app sends when a session you started finishes a turn, or a subagent's answer), it logs the `report` (the helper's own report line for that job, else "Handed in"; never words from its answer), sets the agent `in_review`, and sets you `reviewing` it. A note that says the session was stopped or failed is logged as such, and the agent's status is left to you.
- A helper's permission prompt. With the plugin installed for your user, a permission prompt in any session shows NEEDS YOU at once ("Allow or deny: <tool> <file or host>"), and clears as soon as it is allowed, denied or the turn ends. Without it, the panel guesses after 10 seconds from a tool call still waiting for its result ("May be waiting for your permission: <tool>"), shell commands, subagents, skills and waits excluded; the call's result makes it working again. Do not set those yourself.

So with it on, do not log dispatches and reports by hand. Everything that needs judgement stays yours: the task, the plan and its steps, the queue, `done` (accepted) or `working` (sent back), `needs_user` with your own question, `idle`, and `paused`. Your own writes always win over automatic ones: a dispatch you write is always kept, even a second one to the same agent; only an automatic copy that repeats one already logged is dropped, and your copy replaces an automatic one.

Each helper's card follows its session's transcript, unless the person ran `/mission watch off`: a running turn shows it working, a turn that ended shows it in review (with its own report line, else "Handed in"). You do not write those. Your writes still decide `done`, `queued` and `idle`.

A backstop for a helper with no transcript found: when the desktop app's record of a helper you know says its turn has ended while its card still shows `working`, the plugin moves it to `in_review` within seconds, saying "Handed in". So the report line in your briefs is required: it is the only way the helper's own words reach the pane.

The plugin knows an agent by a role's name in the session's title, handle or subagent type (Explorer, Worker, Tester, Security). For other names, `/mission agents Reviewer=local_1234` (a session id, handle or title words) maps one; `/mission agents` lists them. In a helper session, `/mission role tester` says which helper it is if its brief did not.

The person's commands: `/mission` (open the pane; text in a terminal), `/mission ascii on|off|auto` (the terminal's glyphs), `/mission light|dark|auto` (theme), `/mission measure`, `/mission auto on|off` (automatic reporting), `/mission watch on|off` (the backstop), `/mission agents [role=pattern]`, `/mission role <role>|none`, `/mission debug on|off`.

## Pausing

When you stop on purpose before the task is finished (you are waiting for the person, taking a break, or ending the session), pause it rather than going quiet:

```json
{ "updates": [{ "do": "task.pause", "reason": "Waiting for the owner's answer" }] }
```

The pane shows PAUSED, the plan frozen at the step it stopped at, and the time; it never turns OFFLINE while paused. `task.resume` takes it up again. A task that is running but has nothing written for a minute shows as OFFLINE: the last known state, clearly marked old.

## The plan

- Before any work: `plan.set` with 3 to 7 steps of one or two words each, taken from the task itself. Never use a fixed pipeline: a copy change might be `["Edit", "Review"]`, a bug `["Find", "Fix", "Verify"]`.
- Exactly one step is active. Move on with `plan.step`: `{ "do": "plan.step", "step": "Fix", "status": "active" }`. Marking a step `done` or `skipped` makes the next pending step active.
- A step that is no longer needed is marked `skipped`, never deleted.
- If the plan changes mid-task, `plan.set` again and send a `plan_changed` event saying why.
- For open-ended work, `plan.clear`. Never invent steps.

## The queue

When the person writes while a task runs, decide what it is first.

- A new task: `queue.add` with its text. Do not start it yet.
- A change to the running task: apply it, update the plan if needed, and send a `user_message` event. Do not queue it.
- When the task finishes and the queue is not empty: `queue.promote` (the first item becomes the running task), then `plan.set` for it.
- `queue.remove` with an `index` from 1 removes one item; `queue.clear` removes them all.

## Agents

- The pane seats four agents by default: Explorer, Worker, Tester and Security. Any other name works too and is drawn with a generic bot icon.
- `agent` with the agent's `name`, its `status` and a `task`: one plain sentence, 80 characters at most, on what it is doing now. Update it whenever that changes.
  - `idle`: no part in this task right now. Set without `task`, it clears the agent's old words. Every agent is idle when a task starts, and an agent you never mention stays idle. `task` is optional; the card says "No part in this task" (or "Waiting for a task" when none runs).
  - `queued`: has work coming in this task: you plan to dispatch it. Set it only for an agent you will use, and say in `task` what it is waiting for, such as "Waits for the fix to verify it". Never mark an agent queued just because it is free; leave it idle.
  - `working`: at work.
  - `in_review`: it has handed in its report and waits on you. `task` says what it reported, such as "Reported: 6 checks failed".
  - `done`: you have read its report and accepted the work for this task; `task` says what it found or made. Never set `done` before you have read the report. It clears when the task ends.
  - `needs_user`: waiting on the person. Put the exact question in `task`. Use it for the orchestrator's own questions too. A helper's own question (its next-step question, or a question tool waiting) shows this by itself, and clears when it is answered.

Every status is per task: when a task ends or a new one starts, every agent is idle with no words (a paused task keeps them), and a state written under another task shows idle under this one. For work that is not the current task, mark the dispatch `side: true` (`--side` on the CLI): it is logged with an "other task" mark, the helper's card reads "Other task: …" while it runs, and it goes back to idle when it ends.

```json
{ "updates": [
  { "do": "agent", "name": "Explorer", "status": "working", "task": "Finding where the header's height is set" },
  { "do": "event", "type": "dispatch", "from": "Orchestrator", "to": "Explorer", "text": "Find where the header's height is set" }
] }
```

## When a helper's result arrives

Your first action, before you read it, is one call that shows the hand-over: the agent `in_review` with one line of what it reported, and the `report` event if the helper did not add its own report line. You then show as reviewing it by yourself.

```json
{ "updates": [
  { "do": "agent", "name": "Tester", "status": "in_review", "task": "Reported: 6 checks failed" },
  { "do": "event", "type": "report", "from": "Tester", "to": "Orchestrator", "text": "6 checks failed: lint 2, tests 4" }
] }
```

Then read the report and decide, in the same turn: `{ "do": "accept", "name": "Tester" }` (done, `agent_done` logged, out of your reviewing list; `"name": "all"` for every agent in review, `"text"` for a note) or `{ "do": "sendback", "name": "Tester", "task": "Fix the two lint errors" }` (working again, a dispatch logged). From a shell: `mc.py accept tester [--note "..."]`, `mc.py accept --all`, `mc.py sendback tester --task "..."`. If you try to end your turn with an agent still in review, the plugin asks you once to settle it, or to say why it is still under review.

The longer way, step by step:

- Accepted: the agent `done`, with what it found or made, and an `agent_done` event.
- Sent back: the agent `working` again, with what it is fixing, and a `dispatch` event saying what to fix.

Either way, set your own status again (`waiting`, `dispatching`, `planning`).

## The orchestrator

Your status follows your agents: whom you wait on is always the agents working, whom you review the agents in review; your status is REVIEWING while any agent is in review, WAITING while any works, DONE after `task.done`, else IDLE. The only statuses it sets itself are `planning`, `dispatching` and `needs_user` (`orch` with that status); each shows until an agent's state next changes. `waitingOn` and `reviewing` in an `orch` update (and `--waiting-on`, `--reviewing` on the CLI) are ignored.

## Events

Send one event for each of these, with `type`, `from`, `to` and `text`, one plain sentence of 100 characters at most with the useful detail (a commit, a branch, a number):

| type | when |
| --- | --- |
| `dispatch` | the orchestrator gives an agent work |
| `report` | an agent reports back to the orchestrator |
| `handoff` | one agent passes work to another |
| `agent_done` | the orchestrator has read an agent's report and accepted its work |
| `needs_user` | an agent or the orchestrator needs the person |
| `plan_changed` | the plan was set again, and why |
| `user_message` | the person changed the running task |
| `task_done` | the task is finished |
| `task_failed` | the task could not be finished |
| `progress` | a helper's own line about its work (added by the helper with `say`) |
| `task_paused` | the task was paused, and why (logged by `task.pause` itself) |
| `task_resumed` | the task goes on (logged by `task.resume` itself) |

```json
{ "updates": [
  { "do": "agent", "name": "Tester", "status": "done", "task": "All 214 tests pass on the fix branch" },
  { "do": "event", "type": "agent_done", "from": "Tester", "to": "Orchestrator", "text": "All 214 tests pass on the fix branch" }
] }
```

## Limits

Titles and agent tasks are cut at 80 characters, event text at 100, queue items at 120 and step labels at 24, with an ellipsis. The event log keeps its newest 500 lines once it passes 512 KB.

Refused with a message: a plan of more than 12 steps, a queue of more than 50 items, more than 12 agents, more than 50 updates in one call, a step number of 0 or past the end (steps count from 1, or go by label), and `queue.promote` while a task still runs (send `task.done` or `task.fail` first).
