#!/usr/bin/env python3
"""Mission Control writer: the command-line way to report to the panel.

  mc.py task start --title "..."      mc.py task done | task fail
  mc.py task pause [--reason "..."]   mc.py task resume
  mc.py plan set "Find,Fix,Verify"    mc.py plan step <label|number from 1> active|done|skipped
  mc.py plan clear                    mc.py queue add --text "..."    mc.py queue promote
  mc.py queue clear | queue remove <number from 1>
  mc.py agent <name> <status> --task "..."     (status: idle|queued|working|in_review|done|needs_user)
  mc.py orch <planning|dispatching|working|needs_user>  (the rest, and whom it waits on, follow its agents)
  mc.py event <type> --from X --to Y --text "..."
  mc.py heartbeat                     mc.py heartbeat-loop
  mc.py say --as <role> "..." [--report]       (a helper's own line; it moves only its own card)
  mc.py accept <agent>|--all [--note "..."]    mc.py sendback <agent> --task "..."

The optional command-line writer for the Mission Control plugin. The plugin's own `report` tool
writes the same files by the same rules and needs nothing installed; use this where a script or
another tool reports instead. It writes to <home>/.claude/mission-control (CLAUDE_CONFIG_DIR in
place of <home>/.claude when set), or to MC_DIR, or to --dir <folder>.

Writes of state.json are atomic (a temp file, then a rename). Every command bumps lastUpdated.
events.jsonl is rotated: past 512 KB it keeps its newest 500 lines. A state.json that is not valid
JSON is kept as state.json.bad before the next write replaces it. Python 3 standard library only.
"""

import argparse
import json
import re
import os
import shutil
import sys
import tempfile
import time
import uuid


def default_dir():
    if os.environ.get("MC_DIR"):
        return os.environ["MC_DIR"]
    config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(config, "mission-control")


HOME = os.path.abspath(os.path.expanduser(default_dir()))
STATE = os.path.join(HOME, "state.json")
EVENTS = os.path.join(HOME, "events.jsonl")


def use_dir(folder):
    """Point every read and write at `folder` (the --dir option)."""
    global HOME, STATE, EVENTS
    HOME = os.path.abspath(os.path.expanduser(folder))
    STATE = os.path.join(HOME, "state.json")
    EVENTS = os.path.join(HOME, "events.jsonl")
    os.makedirs(HOME, exist_ok=True)


# The same limits as the plugin's writer (hooks/mission/writer.ts).
TITLE_MAX = 80
TASK_MAX = 80
EVENT_TEXT_MAX = 100
QUEUE_TEXT_MAX = 120
STEP_MAX = 24
NAME_MAX = 24
MAX_STEPS = 12
MAX_QUEUE = 50
MAX_AGENTS = 12
LOG_ROTATE_BYTES = 512 * 1024
LOG_KEEP_LINES = 500
HEARTBEAT_SECONDS = 20

TASK_STATUSES = ("idle", "running", "paused", "done", "failed")
STEP_STATUSES = ("pending", "active", "done", "skipped")
AGENT_STATUSES = ("idle", "queued", "working", "in_review", "done", "needs_user")
ORCH_STATUSES = ("idle", "planning", "dispatching", "working", "waiting", "reviewing", "needs_user", "done")
# The statuses the orchestrator sets itself; every other one is derived from its agents and its turn.
ORCH_OWN = ("planning", "dispatching", "working", "needs_user")
# The updates of one call are timed apart: an agent's change within this is not "after".
SAME_CALL_MS = 64
EVENT_TYPES = (
    "dispatch", "report", "handoff", "agent_done", "needs_user",
    "plan_changed", "user_message", "task_started", "task_done", "task_failed", "progress",
    "task_paused", "task_resumed",
)
PROGRESS_GAP_MS = 5000


def now_ms():
    return int(time.time() * 1000)


def clip(text, limit):
    # Whitespace folded to single spaces first, then any other control character (C0, DEL, C1:
    # escape sequences among them) dropped, so none reaches a file or a screen.
    text = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", " ".join(str(text or "").split()))
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def empty_state():
    return {
        "task": None,
        "plan": None,
        "queue": [],
        "agents": [],
        "orchestrator": {"status": "idle", "waitingOn": [], "reviewing": []},
        "lastUpdated": now_ms(),
    }


# ---- reading: every field checked, as the plugin's parseState does ------------------------------

def _str(value, fallback=""):
    return value if isinstance(value, str) else fallback


def _num(value, fallback=0):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else fallback


def _one_of(value, allowed, fallback):
    return value if value in allowed else fallback


def _dicts(value):
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def normalize(data):
    """The state with each field of the right shape: a field that is not falls back on its own."""
    task = data.get("task")
    if isinstance(task, dict):
        task = {
            "id": _str(task.get("id")),
            "title": _str(task.get("title")),
            "status": _one_of(task.get("status"), TASK_STATUSES, "running"),
            "startedAt": _num(task.get("startedAt")),
            **({"finishedAt": task["finishedAt"]} if _num(task.get("finishedAt"), None) is not None else {}),
            **({"pausedAt": task["pausedAt"]} if _num(task.get("pausedAt"), None) is not None else {}),
            **({"pauseReason": task["pauseReason"]} if isinstance(task.get("pauseReason"), str) else {}),
        }
    else:
        task = None
    plan = [
        {"id": _str(step.get("id"), "s%d" % (index + 1)),
         "label": _str(step.get("label"), "Step %d" % (index + 1)),
         "status": _one_of(step.get("status"), STEP_STATUSES, "pending")}
        for index, step in enumerate(_dicts(data.get("plan")))
    ] or None
    queue = [
        {"id": _str(item.get("id"), "q%d" % index), "text": _str(item.get("text")),
         "receivedAt": _num(item.get("receivedAt"))}
        for index, item in enumerate(_dicts(data.get("queue")))
    ]
    agents = [
        {"id": _str(agent.get("id"), _str(agent.get("name"))), "name": _str(agent.get("name"), "Agent"),
         "status": _one_of(agent.get("status"), AGENT_STATUSES, "idle"),
         "currentTask": _str(agent.get("currentTask")), "startedAt": _num(agent.get("startedAt")),
         **({"taskId": agent["taskId"]} if isinstance(agent.get("taskId"), str) and agent["taskId"] else {})}
        for agent in _dicts(data.get("agents"))
    ]
    # Done and every other status are per task: a state written under another task reads as idle.
    task_id = task["id"] if task else None
    for agent in agents:
        if "taskId" in agent and agent["taskId"] != task_id:
            agent.update(status="idle", currentTask="")
    orch = data.get("orchestrator") if isinstance(data.get("orchestrator"), dict) else {}
    waiting = orch.get("waitingOn") if isinstance(orch.get("waitingOn"), list) else []
    # Absent in state files written before reviewing existed.
    reviewing = orch.get("reviewing") if isinstance(orch.get("reviewing"), list) else []
    return {
        "task": task,
        "plan": plan,
        "queue": queue,
        "agents": agents,
        "orchestrator": {**({"since": orch["since"]} if _num(orch.get("since"), None) is not None else {}),
                         # While its own turn runs (the plugin, in the orchestrator's session): when it began.
                         **({"turn": orch["turn"]} if _num(orch.get("turn"), None) is not None else {}),
                         **({"turnLog": orch["turnLog"]} if isinstance(orch.get("turnLog"), str) and orch["turnLog"] else {}),
                         "status": _one_of(orch.get("status"), ORCH_STATUSES, "idle"),
                         "waitingOn": [name for name in waiting if isinstance(name, str)],
                         "reviewing": [name for name in reviewing if isinstance(name, str)]},
        "lastUpdated": _num(data.get("lastUpdated"), now_ms()),
    }


def keep_bad(reason):
    """Keep the unreadable state.json as state.json.bad, and say so."""
    try:
        shutil.copyfile(STATE, STATE + ".bad")
        print("mc.py: state.json %s; kept it as state.json.bad and started a clean state" % reason, file=sys.stderr)
    except OSError:
        pass


def load():
    try:
        with open(STATE, "rb") as handle:
            raw_bytes = handle.read()
    except FileNotFoundError:
        return empty_state()
    except OSError:
        sys.exit("mc.py: could not read state.json; nothing was written")
    try:
        raw = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        keep_bad("was not UTF-8 text")
        return empty_state()
    try:
        data = json.loads(raw)
    except ValueError:
        keep_bad("was not valid JSON")
        return empty_state()
    if not isinstance(data, dict):
        keep_bad("was not an object")
        return empty_state()
    if data.get("demo"):
        # A sample state is not real work: any real command starts clean.
        return empty_state()
    return normalize(data)


# ---- writing -------------------------------------------------------------------------------------

def atomic_write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        replace(temp, path)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise


def replace(temp, path):
    """os.replace, retried: on Windows it fails while another process has the file open."""
    for attempt in range(20):
        try:
            os.replace(temp, path)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.05)


def orchestrator_of(state):
    """The orchestrator as its agents and its turn show it: the same rule as the plugin (model.ts
    orchestratorOf).

    Whom it waits on is the agents working, whom it reviews the agents in review. Its status, in
    this order: needs_user until the person answers, another status is set or a task starts, ends or
    resumes (no agent's change drops it); reviewing while
    any agent is in review; while its own turn runs (`turn`, written by the plugin only), done if it
    finished the task in this turn, planning or dispatching if it set one in this turn and it stands,
    else working; outside a turn, what it set while that stands; waiting while any agent works; done
    for a finished task, else idle (or what it set, while a task runs)."""
    orch = state.get("orchestrator") or {"status": "idle"}
    agents = state.get("agents") or []
    reviewing = [a["name"] for a in agents if a.get("status") == "in_review"]
    waiting_on = [a["name"] for a in agents if a.get("status") == "working"]
    last_change = max([0] + [a.get("startedAt") or 0 for a in agents])
    since = {"since": orch["since"]} if isinstance(orch.get("since"), (int, float)) else {}
    turn = orch.get("turn") if isinstance(orch.get("turn"), (int, float)) else None
    status = orch.get("status", "idle")
    stands = status in ORCH_OWN and since and since["since"] + SAME_CALL_MS >= last_change
    this_turn = turn is not None and since and since["since"] >= turn
    if status == "needs_user":
        pass
    elif reviewing:
        status = "reviewing"
    elif turn is not None:
        if not ((status == "done" and this_turn) or (status in ("planning", "dispatching") and stands and this_turn)):
            status = "working"
    elif stands:
        pass
    elif waiting_on:
        status = "waiting"
    elif not (state.get("task") or {}).get("status") in ("running", "paused"):
        status = "done" if status == "done" else "idle"
    elif status in ("waiting", "reviewing"):
        status = "idle"
    return {"status": status, "waitingOn": waiting_on, "reviewing": reviewing, **since,
            **({"turn": turn} if turn is not None else {}), **turn_log(orch)}


def turn_log(orch):
    """The transcript of the orchestrator's running turn (written by the plugin), kept as it is."""
    log = (orch or {}).get("turnLog")
    return {"turnLog": log} if isinstance(log, str) and log else {}


def rest_orchestrator(state, status):
    """A task starts or ends: the orchestrator's own status starts over too (idle, or done after task
    done), so nothing it set under one task stays in the circle after it. Its turn is kept."""
    orch = state.get("orchestrator") or {}
    turn = orch.get("turn")
    state["orchestrator"] = {"status": status, "waitingOn": [], "reviewing": [], "since": now_ms(),
                             **({"turn": turn} if isinstance(turn, (int, float)) else {}), **turn_log(orch)}


def save(state):
    state["orchestrator"] = orchestrator_of(state)
    state["lastUpdated"] = now_ms()
    atomic_write(STATE, json.dumps(state, ensure_ascii=False, indent=1) + "\n")


def ends_mid_line(path):
    """Whether the file ends without a newline (a half-written last line)."""
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                return False
            handle.seek(-1, os.SEEK_END)
            return handle.read(1) != b"\n"
    except OSError:
        return False


DEDUPE_MS = 10 * 60 * 1000


def automatic_twin(kind, sender, target, at, lines):
    """
    The index of the log line this dispatch or report repeats, when that line was written by the
    plugin's automatic reporting ("auto": true), so this writer's own copy can take its place: one
    report per dispatch, and no second dispatch to an agent before it has reported, within 10
    minutes. None when there is no such line, or the earlier one is someone's own (both are kept).
    """
    agent = str((sender if kind == "report" else target) or "").lower()
    for index in range(len(lines) - 1, max(-1, len(lines) - 201), -1):
        try:
            event = json.loads(lines[index])
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        frm = str(event.get("from") or "").lower()
        to = str(event.get("to") or "").lower()
        is_report = event.get("type") == "report" and frm == agent
        is_dispatch = event.get("type") == "dispatch" and to == agent
        if not (is_report or is_dispatch):
            continue
        same = is_report if kind == "report" else (is_dispatch and at - _num(event.get("time")) <= DEDUPE_MS)
        return index if same and event.get("auto") is True else None
    return None


TASK_ENDS = ("task_started", "task_done", "task_failed")


def task_end_twin(kind, task_id, lines):
    """The index of the log line logging the same start or end (`kind`) of the same task, with
    whether the plugin or this writer wrote it automatically; None when there is none."""
    if not task_id:
        return None
    for index in range(len(lines) - 1, max(-1, len(lines) - 201), -1):
        try:
            event = json.loads(lines[index])
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == kind and event.get("taskId") == task_id:
            return index, event.get("auto") is True
    return None


def append_event(kind, sender, target, text, at=None, side=False, auto=False):
    if kind not in EVENT_TYPES:
        sys.exit("event type must be one of: " + ", ".join(EVENT_TYPES))
    event = {"time": at or now_ms(), "type": kind, "from": clip(sender, NAME_MAX).lower(), "to": clip(target, NAME_MAX).lower(),
             "text": clip(text, EVENT_TEXT_MAX)}
    # Every event carries the task that was current when it was written; side work says so.
    task_id = current_task_id()
    if task_id:
        event["taskId"] = task_id
    if side:
        event["side"] = True
    if auto:
        event["auto"] = True
    line = json.dumps(event, ensure_ascii=False)
    os.makedirs(HOME, exist_ok=True)
    if kind in TASK_ENDS:
        # One line per task's start or end: an automatic one gives way to someone's own, either order.
        try:
            with open(EVENTS, "r", encoding="utf-8", errors="replace") as handle:
                lines = handle.read().splitlines()
        except OSError:
            lines = []
        twin = task_end_twin(kind, task_id, lines)
        if twin is not None and auto:
            return
        if twin is not None and twin[1]:
            del lines[twin[0]]
            atomic_write(EVENTS, "".join(line + "\n" for line in lines if line.strip() and "\ufffd" not in line))
    if kind in ("dispatch", "report"):
        # This writer's copy wins over the plugin's automatic one: that line goes, this one is added.
        try:
            with open(EVENTS, "r", encoding="utf-8", errors="replace") as handle:
                lines = handle.read().splitlines()
        except OSError:
            lines = []
        twin = automatic_twin(kind, clip(sender, NAME_MAX), clip(target, NAME_MAX), at or now_ms(), lines)
        if twin is not None:
            del lines[twin]
            atomic_write(EVENTS, "".join(line + "\n" for line in lines if line.strip() and "\ufffd" not in line))
    # A half-written last line is closed first, so the new event is not glued onto it.
    lead = "\n" if ends_mid_line(EVENTS) else ""
    # One write of a whole line: the panel only reads up to the last newline.
    with open(EVENTS, "a", encoding="utf-8", newline="\n") as out:
        out.write(lead + line + "\n")
    rotate()


def rotate():
    """Past LOG_ROTATE_BYTES, keep the newest LOG_KEEP_LINES lines (the panel reads the shrunk log afresh)."""
    try:
        if os.path.getsize(EVENTS) <= LOG_ROTATE_BYTES:
            return
        with open(EVENTS, "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return
    # Lines that were not UTF-8 text (now holding U+FFFD) are dropped, not written back.
    kept = [line for line in lines if line.strip() and "\ufffd" not in line][-LOG_KEEP_LINES:]
    atomic_write(EVENTS, "".join(line + "\n" for line in kept))


def rest_agents(state):
    """A task starts or ends: every agent is idle with no words and no task, until the orchestrator
    says otherwise. Done is per task: nothing from one task stays on a card under the next."""
    for agent in state["agents"]:
        if agent["status"] != "idle" or agent["currentTask"]:
            agent["startedAt"] = now_ms()
        agent["status"] = "idle"
        agent["currentTask"] = ""
        agent.pop("taskId", None)


def own_task(state, agent):
    """An agent's state now belongs to the current task (or to none, when there is none)."""
    if state["task"]:
        agent["taskId"] = state["task"]["id"]
    else:
        agent.pop("taskId", None)


def current_task_id():
    """The id of the task in state.json now, read lightly (no repair): events carry it."""
    try:
        with open(STATE, "r", encoding="utf-8") as handle:
            task = json.load(handle).get("task")
        return task.get("id") if isinstance(task, dict) and isinstance(task.get("id"), str) else None
    except (OSError, ValueError, AttributeError):
        return None


def find_step(plan, ref):
    """A step by its number from 1, or by its label or id. 0 and numbers past the end are refused."""
    if ref.isdigit():
        number = int(ref)
        if 1 <= number <= len(plan):
            return plan[number - 1]
        sys.exit("plan step takes a number from 1 to %d, or a label" % len(plan))
    for step in plan:
        if step["label"].lower() == ref.lower() or step["id"] == ref:
            return step
    sys.exit("no step " + repr(ref))


# ---- commands ------------------------------------------------------------------------------------

def cmd_task(args):
    state = load()
    logged = None
    if args.action == "start":
        if not args.title:
            sys.exit("task start needs --title")
        state["task"] = {"id": uuid.uuid4().hex[:8], "title": clip(args.title, TITLE_MAX),
                         "status": "running", "startedAt": now_ms()}
        rest_agents(state)
        rest_orchestrator(state, "idle")
        logged = ("task_started", "Started")
    elif args.action == "pause":
        if not state["task"] or state["task"]["status"] != "running":
            sys.exit("only a running task can be paused")
        why = clip(args.reason, EVENT_TEXT_MAX)
        state["task"]["status"] = "paused"
        state["task"]["pausedAt"] = now_ms()
        state["task"].pop("pauseReason", None)
        if why:
            state["task"]["pauseReason"] = why
        append_event("task_paused", "Orchestrator", "", "Paused: " + why if why else "Paused")
    elif args.action == "resume":
        if not state["task"] or state["task"]["status"] != "paused":
            sys.exit("the task is not paused")
        state["task"]["status"] = "running"
        state["task"].pop("pausedAt", None)
        state["task"].pop("pauseReason", None)
        # Going on answers the orchestrator's own question.
        if (state.get("orchestrator") or {}).get("status") == "needs_user":
            rest_orchestrator(state, "idle")
        append_event("task_resumed", "Orchestrator", "", "Resumed")
    else:
        if not state["task"]:
            sys.exit("no task")
        state["task"]["status"] = "done" if args.action == "done" else "failed"
        state["task"]["finishedAt"] = now_ms()
        if args.action == "done" and state["plan"]:
            for step in state["plan"]:
                if step["status"] in ("active", "pending"):
                    step["status"] = "done"
        rest_agents(state)
        rest_orchestrator(state, "done" if args.action == "done" else "idle")
        logged = ("task_done", "Finished") if args.action == "done" else ("task_failed", "Failed")
    save(state)
    # After the save, so it carries the task's id (a new one for a start). Automatic: the
    # orchestrator's own task_done or task_failed for this task takes its place.
    if logged:
        append_event(logged[0], "orchestrator", "", logged[1], auto=True)


def cmd_plan(args):
    state = load()
    if args.action == "set":
        labels = [label.strip() for label in (args.value or "").split(",") if label.strip()]
        if not labels:
            sys.exit('plan set needs labels: "Find,Fix,Verify"')
        if len(labels) > MAX_STEPS:
            sys.exit("a plan has at most %d steps (3 to 7 is the guide)" % MAX_STEPS)
        state["plan"] = [
            {"id": "s%d" % (index + 1), "label": clip(label, STEP_MAX), "status": "active" if index == 0 else "pending"}
            for index, label in enumerate(labels)
        ]
    elif args.action == "clear":
        state["plan"] = None
    elif args.action == "step":
        if not state["plan"]:
            sys.exit("no plan")
        if args.status not in STEP_STATUSES:
            sys.exit("step status must be one of: " + ", ".join(STEP_STATUSES))
        step = find_step(state["plan"], args.value)
        if args.status == "active":
            # Exactly one active step.
            for other in state["plan"]:
                if other["status"] == "active":
                    other["status"] = "done"
        step["status"] = args.status
        if args.status in ("done", "skipped") and not any(s["status"] == "active" for s in state["plan"]):
            for other in state["plan"]:
                if other["status"] == "pending":
                    other["status"] = "active"
                    break
    save(state)


def cmd_queue(args):
    state = load()
    if args.action == "add":
        if not args.text:
            sys.exit("queue add needs --text")
        if len(state["queue"]) >= MAX_QUEUE:
            sys.exit("the queue holds at most %d items" % MAX_QUEUE)
        state["queue"].append({"id": uuid.uuid4().hex[:8], "text": clip(args.text, QUEUE_TEXT_MAX),
                               "receivedAt": now_ms()})
    elif args.action == "clear":
        state["queue"] = []
    elif args.action == "remove":
        if not args.index or not args.index.isdigit() or not 1 <= int(args.index) <= len(state["queue"]):
            sys.exit("queue remove needs a number from 1 to %d" % len(state["queue"]))
        state["queue"].pop(int(args.index) - 1)
    elif args.action == "promote":
        if not state["queue"]:
            sys.exit("the queue is empty")
        if state["task"] and state["task"]["status"] in ("running", "paused"):
            sys.exit("a task is still running: finish it with task done or task fail, then promote")
        item = state["queue"].pop(0)
        state["task"] = {"id": item["id"], "title": clip(item["text"], TITLE_MAX), "status": "running",
                         "startedAt": now_ms()}
        state["plan"] = None
        rest_agents(state)
        rest_orchestrator(state, "idle")
    save(state)


def cmd_agent(args):
    if args.status not in AGENT_STATUSES:
        sys.exit("agent status must be one of: " + ", ".join(AGENT_STATUSES))
    state = load()
    name = clip(args.name, NAME_MAX)
    if not name:
        sys.exit("agent needs a name")
    agent = next((a for a in state["agents"] if a["name"].lower() == name.lower()), None)
    if agent is None:
        if len(state["agents"]) >= MAX_AGENTS:
            sys.exit("at most %d agents" % MAX_AGENTS)
        agent = {"id": name.lower(), "name": name, "status": "idle", "currentTask": "", "startedAt": now_ms()}
        state["agents"].append(agent)
    if agent["status"] != args.status:
        agent["startedAt"] = now_ms()
    agent["status"] = args.status
    own_task(state, agent)
    if args.task is not None:
        agent["currentTask"] = clip(args.task, TASK_MAX)
    elif args.status == "idle":
        # Idle with nothing said: no stale words from its last job stay on its card.
        agent["currentTask"] = ""
    save(state)


def cmd_orch(args):
    if args.status not in ORCH_STATUSES:
        sys.exit("orch status must be one of: " + ", ".join(ORCH_STATUSES))
    state = load()
    # Whom it waits on and reviews come from the agents (orchestrator_of, in save); --waiting-on and
    # --reviewing are still accepted from older scripts, and ignored.
    turn = state["orchestrator"].get("turn")
    state["orchestrator"] = {"status": args.status, "waitingOn": [], "reviewing": [], "since": now_ms(),
                             **({"turn": turn} if isinstance(turn, (int, float)) else {}), **turn_log(state["orchestrator"])}
    save(state)


def cmd_event(args):
    state = load()
    append_event(args.type, args.sender, args.target, args.text, side=args.side)
    save(state)


def role_name(name):
    name = clip(name, NAME_MAX)
    return name[:1].upper() + name[1:]


def last_progress_time(agent):
    """The time of the agent's newest progress line in the log's last lines, or None."""
    try:
        with open(EVENTS, "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()[-200:]
    except OSError:
        return None
    for line in reversed(lines):
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "progress" and str(event.get("from", "")).lower() == agent.lower():
            return _num(event.get("time"), None)
    return None


def cmd_say(args):
    """
    A helper's own line about its work: a progress event (or, with --report, its report line),
    from its own role, and its own card moved by own_status (its hand-in, its start). It writes
    nothing else: not the task, the plan, the queue, another agent or the orchestrator.
    A progress line within 5 seconds of the same agent's last one is dropped without a word.
    """
    who = role_name(args.as_role or "")
    if not who:
        sys.exit("say needs --as <your role>")
    if who.lower() in ("orchestrator", "owner", "person", "user"):
        sys.exit("say is for a helper: %r is not a helper's role" % who)
    text = clip(args.text, EVENT_TEXT_MAX)
    if not text:
        sys.exit("say needs the line to add")
    kind = "report" if args.report else "progress"
    at = now_ms()
    # A plain line opening with a hand-in word, from a working agent, is its report.
    state = load()
    agent = next((a for a in state["agents"] if a["name"].lower() == who.lower()), None)
    if kind == "progress" and agent and agent["status"] == "working" and HAND_IN.match(text):
        kind = "report"
    if kind == "progress":
        last = last_progress_time(who)
        if last is not None and at - last < PROGRESS_GAP_MS:
            return
    append_event(kind, who, "Orchestrator" if kind == "report" else "", text, at=at)
    own_status(kind, who, text)


HAND_IN = re.compile(r"^\s*(?:(?:done|finished|handing in|pass|fail)\b|(?:final|report)[:\-–—])", re.IGNORECASE)


def own_status(kind, who, text):
    """
    What a helper's own line does to its own card, and nothing else's. Its report (or a progress
    line opening with a hand-in word, from a working agent) hands in: working or needs_user to
    in_review, the report as its line. Any other line from an agent not working (queued, idle, in
    review, done) means it has started a job: working, the timer restarted, that line as its task
    (an agent queued or idle keeps a task the orchestrator set). Returns the kind it was logged as.
    """
    state = load()
    agent = next((a for a in state["agents"] if a["name"].lower() == who.lower()), None)
    status = agent["status"] if agent else "idle"
    if kind == "progress" and status == "working" and HAND_IN.match(text):
        kind = "report"
    if kind == "report":
        if status not in ("working", "needs_user"):
            return kind
        new, line = "in_review", clip(text, TASK_MAX)
    else:
        if status in ("working", "needs_user"):
            return kind
        keep = status in ("queued", "idle") and agent and agent["currentTask"]
        new, line = "working", (agent["currentTask"] if keep else clip(text, TASK_MAX))
    if agent is None:
        if len(state["agents"]) >= MAX_AGENTS:
            return kind
        agent = {"id": who.lower(), "name": who, "status": new, "currentTask": "", "startedAt": now_ms()}
        state["agents"].append(agent)
    agent["status"] = new
    agent["currentTask"] = line
    agent["startedAt"] = now_ms()
    own_task(state, agent)
    save(state)
    return kind


def cmd_accept(args):
    """One step: the agent done, agent_done logged, out of the orchestrator's reviewing list."""
    state = load()
    if args.all or not args.name:
        chosen = [a for a in state["agents"] if a["status"] == "in_review"]
        if not chosen:
            sys.exit("no agent is in review")
    else:
        chosen = [a for a in state["agents"] if a["name"].lower() == clip(args.name, NAME_MAX).lower()]
        if not chosen:
            sys.exit("no agent %r" % args.name)
    note = clip(args.note, TASK_MAX)
    for agent in chosen:
        agent["status"] = "done"
        agent["startedAt"] = now_ms()
        own_task(state, agent)
        if note:
            agent["currentTask"] = note
    names = set(a["name"].lower() for a in chosen)
    state["orchestrator"]["reviewing"] = [n for n in state["orchestrator"].get("reviewing", []) if n.lower() not in names]
    if len(chosen) == 1:
        append_event("agent_done", chosen[0]["name"].lower(), "orchestrator", note or "Accepted")
    else:
        append_event("agent_done", "orchestrator", "", note or "Accepted: " + ", ".join(a["name"] for a in chosen))
    save(state)


def cmd_sendback(args):
    """One step: back to working with what to fix, a dispatch logged, its timer restarted."""
    state = load()
    name = clip(args.name, NAME_MAX)
    agent = next((a for a in state["agents"] if a["name"].lower() == name.lower()), None)
    if agent is None:
        sys.exit("no agent %r" % args.name)
    task = clip(args.task, TASK_MAX)
    if not task:
        sys.exit("sendback needs --task: what to fix")
    agent["status"] = "working"
    agent["currentTask"] = task
    agent["startedAt"] = now_ms()
    own_task(state, agent)
    state["orchestrator"]["reviewing"] = [n for n in state["orchestrator"].get("reviewing", []) if n.lower() != name.lower()]
    append_event("dispatch", "orchestrator", name.lower(), task)
    save(state)


def cmd_heartbeat(_args):
    save(load())


def lock_holder_alive(pid):
    """Whether the process that wrote the lock is still running. Only where signal 0 is a pure check
    (macOS, Linux); on Windows os.kill would end the process, so there the lock's age alone decides."""
    if os.name != "posix" or pid <= 0:
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def cmd_heartbeat_loop(_args):
    """
    Optional, for a script that reports through this CLI alone: the plugin keeps a running task live
    by itself. Keeps a running task's state fresh every 20 seconds, and stops when the task ends.
    Only one loop runs per data folder: a lock file holds its id, the time it was last refreshed and
    its process id. Another loop's lock is honoured only while it is under a minute old and (on macOS
    and Linux) its process is still running; otherwise it is replaced.
    """
    lock = os.path.join(HOME, ".heartbeat.lock")
    me = uuid.uuid4().hex
    try:
        with open(lock, "r", encoding="utf-8") as handle:
            parts = handle.read().split()
        stamp = float(parts[1])
        pid = int(parts[2]) if len(parts) > 2 else 0
        if time.time() - stamp < 3 * HEARTBEAT_SECONDS and lock_holder_alive(pid):
            print("mc.py: a heartbeat loop is already running for this folder", file=sys.stderr)
            return
    except (OSError, ValueError, IndexError):
        pass
    try:
        while True:
            state = load()
            if not state["task"] or state["task"]["status"] != "running":
                return
            with open(lock, "w", encoding="utf-8") as handle:
                handle.write("%s %f %d" % (me, time.time(), os.getpid()))
            save(state)
            time.sleep(HEARTBEAT_SECONDS)
    finally:
        try:
            with open(lock, "r", encoding="utf-8") as handle:
                if handle.read().split()[0] == me:
                    os.unlink(lock)
        except (OSError, IndexError):
            pass


def main():
    parser = argparse.ArgumentParser(description="Mission Control writer")
    parser.add_argument("--dir", help="write here instead of <home>/.claude/mission-control (also MC_DIR)")
    sub = parser.add_subparsers(dest="command", required=True)

    task = sub.add_parser("task")
    task.add_argument("action", choices=("start", "done", "fail", "pause", "resume"))
    task.add_argument("--title")
    task.add_argument("--reason")
    task.set_defaults(run=cmd_task)

    plan = sub.add_parser("plan")
    plan.add_argument("action", choices=("set", "step", "clear"))
    plan.add_argument("value", nargs="?")
    plan.add_argument("status", nargs="?")
    plan.set_defaults(run=cmd_plan)

    queue = sub.add_parser("queue")
    queue.add_argument("action", choices=("add", "promote", "clear", "remove"))
    queue.add_argument("index", nargs="?")
    queue.add_argument("--text")
    queue.set_defaults(run=cmd_queue)

    agent_cmd = sub.add_parser("agent")
    agent_cmd.add_argument("name")
    agent_cmd.add_argument("status")
    agent_cmd.add_argument("--task")
    agent_cmd.set_defaults(run=cmd_agent)

    orch = sub.add_parser("orch")
    orch.add_argument("status")
    orch.add_argument("--waiting-on", dest="waiting_on", help="ignored: derived from the agents")
    orch.add_argument("--reviewing", help="ignored: derived from the agents")
    orch.set_defaults(run=cmd_orch)

    event = sub.add_parser("event")
    event.add_argument("type", choices=EVENT_TYPES)
    event.add_argument("--from", dest="sender", default="")
    event.add_argument("--to", dest="target", default="")
    event.add_argument("--text", default="")
    event.add_argument("--side", action="store_true", help="work for something other than the current task (an \"other task\" mark)")
    event.set_defaults(run=cmd_event)

    say = sub.add_parser("say")
    say.add_argument("text")
    say.add_argument("--as", dest="as_role")
    say.add_argument("--report", action="store_true")
    say.set_defaults(run=cmd_say)

    accept = sub.add_parser("accept")
    accept.add_argument("name", nargs="?")
    accept.add_argument("--all", action="store_true")
    accept.add_argument("--note")
    accept.set_defaults(run=cmd_accept)

    sendback = sub.add_parser("sendback")
    sendback.add_argument("name")
    sendback.add_argument("--task")
    sendback.set_defaults(run=cmd_sendback)

    sub.add_parser("heartbeat").set_defaults(run=cmd_heartbeat)
    sub.add_parser("heartbeat-loop").set_defaults(run=cmd_heartbeat_loop)

    args = parser.parse_args()
    if args.dir:
        use_dir(args.dir)
    if args.command == "plan" and args.action == "step" and (not args.value or not args.status):
        sys.exit("plan step needs <label|number from 1> <active|done|skipped>")
    args.run(args)


if __name__ == "__main__":
    main()
