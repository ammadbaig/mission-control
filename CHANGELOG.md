# Changelog

## 1.0.5

- The `/mission size` command is gone; `/mission measure` still measures the row height and keeps it in `.panel.json`.

## 1.0.4

- A changed drawing (an agent card switching status, say) no longer shows on top of the old one: the old one stays alone while the new one loads hidden, then the new one alone.

## 1.0.3

1.0.2 was never published; its changes are here too.

- The panel is always drawn: no measuring drawing at start or on a resize, which redraws it at the new size at once (1.0.2 went blank for up to 15 seconds on each resize). Its width comes from the pane's columns (10.68px each) and its height from its rows (20.3px each by default, on the short side so no card falls below the pane); `/mission size <px>` (or `auto`) sets the row height by hand and `/mission measure` measures it, only when asked; either is kept in `.panel.json` for every session. Nothing is measured by itself.
- `/mission debug on` also writes the pane's numbers (columns and rows, the column and row sizes in use, where the row size came from, the scale and the height budget) to `.panel-debug.json` whenever the columns or rows change.
- A slash command typed in a helper's session (`/mission`, say) is not a running turn, and no longer brings back an old brief as "Other task: …".
- A helper knows its own role from the orchestrator's record of its session (`.roles.json`, by session id) when its brief did not name it, and keeps it across a reload.
- In a helper's own session, a tool call (not a shell command, subagent, skill or wait) still open after 1 second shows NEEDS YOU, "May be waiting for you: <tool>"; a prompt Claude Code reports replaces that with its exact words at once; it clears when the call returns. The orchestrator's 10-second guess stays the fallback for helpers without the plugin.

## 1.0.1

- 1.0.1: the permission guess shows after 10 seconds (it was 30), so a person watching sees NEEDS YOU while the prompt is still open. A call with no tool name is never guessed at.

## 1.0.0

- The Mission Control pane for the desktop app: the current task with its plan and latest update, the queue, the agents graph and cards, and the Activity view with every event.
- The `report` tool (`mcp__mission-control__report`): the orchestrator reports through it, several updates per call. It needs no other program.
- The reporting rules ship with the plugin: a short system-prompt section and the `mission-control` skill.
- A heartbeat: while the reporting session's task runs, the pane stays LIVE.
- `/mission`, `/mission light|dark|auto` and `/mission measure`.
- The data folder is found at run time on macOS, Windows and Linux (`<home>/.claude/mission-control`, or `MC_DIR`).
- An optional command-line writer, `cli/mc.py`, for scripts and other tools (Python 3).
- Four example helper agents (Explorer, Worker, Tester, Security) in `examples/agents/`, and a set-up guide in the README.
- MIT licence.
- An `idle` agent status, separate from `queued`: idle is an agent with no part in the task (every agent's state when a task starts or none runs, and the default for one never mentioned); queued is one with work coming. Idle cards, nodes and links are the quietest state, and the legend counts them.
- Both writers check every field of state.json, keep an unreadable one as state.json.bad, close a half-written event line before adding one, refuse to promote while a task runs, count steps from 1, and cap plans at 12 steps, queues at 50 items, agents at 12 and tool calls at 50 updates.
- The heartbeat runs only while the reporting session's task does; the CLI's heartbeat loop runs once per data folder.
- A self-contained tsconfig.json, a development section in the README, screenshots and an icon.
- An `in_review` agent status and a `reviewing` orchestrator status: an agent that has handed in its report shows IN REVIEW, in pink, until the orchestrator has read it and set it `done` (accepted) or `working` (sent back). `done` now means accepted. The rules tell the orchestrator to show the hand-over first.
- The agents legend shows only states with at least one agent (ACTIVE always), counts every reported agent, and wraps onto a second row when it does not fit, taking the height from the graph.
- Every agent's own activity: a `progress` event type, and a helper-only `say` (the tool with `as`, or `mc.py say --as <role>`) that adds only lines about the helper's own work, at most one progress line per agent every 5 seconds. The Activity view groups an agent's lines under its name, the orchestrator's are quieter, a working card shows the agent's newest line under its task, and a progress line pulses the agent's node.
- Paused, offline and idle are told apart: `task.pause` (with a reason) and `task.resume`; PAUSED freezes the plan at its step and never turns offline; OFFLINE (a running task quiet for a minute) shows the last known state, dimmed and still, with when it was last heard of; IDLE when nothing runs. An agent set idle without words loses its old ones.
- Seamless updates: a drawing whose content has not changed is kept as it is, so the app keeps its frame and its animations run on (its new source may differ only in the animation delays that keep pulses in step, and the swap treats that difference as no change); a changed drawing is laid under the one it replaces until it has loaded (400ms), so nothing blinks. An event's packets are a drawing of their own over the agents, and the latest-update row's chevron no longer redraws with every event.
- The gaps between sections stay the design's at every pane size: a taller pane grows the agents area (graph up to 360, cards up to 140) and leaves the rest empty at the bottom.
- Automatic reporting (on by default; `/mission auto on|off`): briefs to helpers become dispatches, helpers' results become reports with the agent in review, and a helper session's own permission prompt shows NEEDS YOU until it is answered. The orchestrator writes only what needs judgement; its own writes win, and duplicates within 10 seconds are kept once. `/mission agents` maps other names to agents.
- Automatic reporting learns helpers' ids from the session's own list of linked sessions and keeps them across reloads; an automatic event is marked, and the orchestrator's own copy always replaces it. `/mission agents` shows the loaded version, and `/mission debug on|off` writes each brief call (its name and input keys only) and each note's handling to `.panel-debug.json`.
- A helper's own report line moves its own card to in review at once, and its first line on a job to working, in both writers; nothing else changes. The orchestrator-side report stays as a backstop and never logs twice.
- No status goes stale: `accept` and `sendback` in one step (tool and CLI); a turn-end guard that asks the orchestrator once to settle an agent in review, a question answered since, or an agent working on a finished task; an agent in review over 2 minutes shows how long; the orchestrator's status follows its agents.
- Security: a permission prompt is logged by its kind only (no command, no path, host only); only the app's own notes and briefs are read; a helper may not say as the orchestrator or the person; with no home folder nothing is read or written and the pane says so.
- Non-UTF-8 files: the CLI keeps a `state.json` that is not UTF-8 text as `state.json.bad` and starts clean, saying so; it skips undecodable lines in `events.jsonl` and never loses the new event.
- A helper never shows in review while it works: any line from an agent that is not working starts a new job (working, timer restarted, the line as its task), and a working agent's line opening with a hand-in word (Done, Finished, Handing in, PASS, FAIL, or Final: and Report: with a colon) is its report, in both writers.
- A backstop for a missing report line: the orchestrator's plugin watches the desktop app's records of the sessions it started and moves a working agent to in review within seconds of its session finishing a turn (`/mission watch on|off`). The report line in briefs is required.
- The lists of event types, statuses and commands match across the README, the skill, the contract and both writers; the README says plainly that the type-check needs Claude Code to have loaded the plugin once.
- Status from the helpers' own transcripts: every second the orchestrator's plugin checks each helper's transcript and reads its last 256 KB when it changes. Running is working (timed from the turn's start), an ended turn is in review with the helper's report line; nobody writes those. `/mission agents` takes a worktree name or a transcript path.
- `state.json` stores the orchestrator's status as its agents show it, as the pane does.
- Privacy: an automatic hand-in (from a note, a subagent's answer, a transcript or a record) says only the helper's own report line, else "Handed in"; nothing from its answer reaches the log or the pane. The plugin reads only the known helpers' app records and the last 256 KB of their transcripts, never more, and the README has a Privacy section.
- One rule for the orchestrator, in both writers and the pane: whom it waits on and reviews always comes from the agents; its status is reviewing, waiting, done or idle as they show, except `planning`, `dispatching` and the new `needs_user`, which it sets itself and which hold until an agent's state changes. `waitingOn` and `reviewing` in an `orch` update (and the CLI's `--waiting-on`, `--reviewing`) are ignored.
- A dispatch the orchestrator writes is always kept; only an automatic copy is dropped. The README and the skill now say so.
- Transcripts: every stop reason but a tool call ends a turn (`max_tokens` included); a transcript unchanged for 10 minutes is not running, and its card shows "Not running: last seen <time>".
- Events carry lower-case ids in `from` and `to`, from every writer; the pane capitalises them.
- The contract takes its lists from the writer; `python3 tests/check-lists.py` checks the README, the skill and the CLI against it. The type-check needs only the engine's `claude-code` declarations, and the README gives the real route, with its trust question and its output.
- A running helper always shows working: after a hand-in, a queued brief that starts it again turns its card back to working within a second (with that brief as its task), an `accept` while it runs is logged and leaves it working, and the turn-end guard skips it. The follower starts at once after a reload and runs again right after each of the plugin's writes.
- Liveness needs no other process: any write to either file is a sign of life, and the orchestrator's plugin marks a running task fresh every 20 seconds from its own clock. OFFLINE only after a minute with no sign of life; never for a paused or idle task. `heartbeat-loop` replaces a lock whose process has gone, and is no longer on the README's main path.
- `pause_turn` (a server pause) does not end a turn. A transcript unchanged for 10 minutes shows its card idle, "Not running: last seen <time>": the one intended exception to "a running session always shows working".
- Hand-in words: Final and Report hand in only with `:`, `-`, `–` or `—` right after the word (not bare, not with a space before it), the same in both writers.
- The version shown in replies and the debug file is read from plugin.json, so there is one value.
- Every status is per task: each agent's state and each event carry the task id current when written; a task's end (or a new task) makes every agent idle with no words, a paused task keeps its cards, and a state of another task shows idle. Old files without task ids count as the current task's. Work for something else is marked on its dispatch (`side`, `--side`): an "Other task ·" mark in the Activity view, "Other task: …" on the card while its session runs, idle when it ends.
- A helper's question is NEEDS YOU by itself: the transcript watcher sees a turn that ends on a next-step question (`wrap_up` with `ask`) or a question tool waiting (`AskUserQuestion` with no result), shows the question (80 characters) and logs one `needs_user` event; the answer makes it working again. A final message ending with "?" does not count. The turn-end guard no longer names an agent showing Needs you.
- The pane in the terminal, as text: the same data, rules and commands, laid out in the pane's columns and rows (title and pill, the task with its steps and caption, the latest update, up next, the agents with their state words and timers), fitted to short panes, with Activity on `a` and Back on `b`, the terminal theme's colours, and `/mission ascii on|off|auto` for plain ASCII. The plan's rules and each agent's words are shared with the desktop drawing (`planOf`, `STATE_WORD`, `messageOf`), so the two cannot disagree.
- NEEDS YOU on a permission prompt: with the plugin in the helper's session, at once ("Allow or deny: <tool> <file or host>"), cleared when the call gets its result, is denied, or the turn ends; without it, a guess after 10 seconds from a tool call still waiting for its result ("May be waiting for your permission: <tool>"), never for shell commands, subagents, skills or waits, and never over the helper's own NEEDS YOU, a question, in review or done.
