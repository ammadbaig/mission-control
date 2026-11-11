"""Checks of the command-line writer that the plugin's test kit cannot run. Run: python3 tests/cli-test.py

Each check writes to its own scratch folder (MC_DIR), never to the real data folder.
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

CLI = str(pathlib.Path(__file__).resolve().parent.parent / "cli" / "mc.py")
failures = []


def run(folder, *args, wait=True):
    env = dict(os.environ, MC_DIR=folder)
    if not wait:
        return subprocess.Popen([sys.executable, CLI, *args], env=env, stderr=subprocess.PIPE, text=True)
    return subprocess.run([sys.executable, CLI, *args], env=env, capture_output=True, text=True)


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + ((": " + detail) if detail and not ok else ""))
    if not ok:
        failures.append(name)


def state(folder):
    return json.loads(pathlib.Path(folder, "state.json").read_text(encoding="utf-8"))


with tempfile.TemporaryDirectory() as folder:
    # The orchestrator's status and lists come from the agents, whatever the command says.
    run(folder, "task", "start", "--title", "T")
    run(folder, "agent", "Explorer", "working", "--task", "x")
    run(folder, "orch", "waiting", "--waiting-on", "Worker")
    orch = state(folder)["orchestrator"]
    check("orch: whom it waits on is read from the agents", orch["status"] == "waiting" and orch["waitingOn"] == ["Explorer"], str(orch))
    run(folder, "orch", "planning")
    check("orch: its own planning holds", state(folder)["orchestrator"]["status"] == "planning")
    run(folder, "agent", "Worker", "in_review", "--task", "r")
    check("orch: an agent's change ends it", state(folder)["orchestrator"]["status"] == "reviewing")

    # A heartbeat lock whose process is gone (fresh by its time) is replaced, not obeyed.
    lock = pathlib.Path(folder, ".heartbeat.lock")
    lock.write_text("someone %f 999999" % time.time(), encoding="utf-8")
    loop = run(folder, "heartbeat-loop", wait=False)
    deadline = time.time() + 5
    while time.time() < deadline and "999999" in lock.read_text(encoding="utf-8"):
        time.sleep(0.1)
    taken = lock.exists() and "999999" not in lock.read_text(encoding="utf-8")
    run(folder, "task", "done")
    loop.terminate()
    loop.wait()
    if os.name == "posix":
        check("heartbeat-loop: a lock whose process is gone is replaced", taken)
    # A fresh lock whose process runs (this one) is honoured.
    lock.write_text("someone %f %d" % (time.time(), os.getpid()), encoding="utf-8")
    run(folder, "task", "start", "--title", "T2")
    answer = run(folder, "heartbeat-loop")
    check("heartbeat-loop: a running loop's lock is honoured", "already running" in answer.stderr, answer.stderr)
    run(folder, "task", "done")

def events(folder):
    return [json.loads(line) for line in pathlib.Path(folder, "events.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]


with tempfile.TemporaryDirectory() as folder:
    # Done is per task: states and events carry the task; a task's end idles every agent.
    run(folder, "task", "start", "--title", "One")
    one = state(folder)["task"]["id"]
    run(folder, "agent", "Explorer", "done", "--task", "Found it")
    run(folder, "event", "agent_done", "--from", "explorer", "--to", "orchestrator", "--text", "Found it")
    check("idle rule: an agent's state carries its task", state(folder)["agents"][0].get("taskId") == one)
    check("idle rule: an event carries its task", events(folder)[-1].get("taskId") == one)
    run(folder, "task", "done")
    agent = state(folder)["agents"][0]
    check("idle rule: a task's end idles every agent", agent["status"] == "idle" and agent["currentTask"] == "" and "taskId" not in agent, str(agent))
    # A state of another task reads as idle; one without a task id belongs to the current task.
    data = state(folder)
    data["task"] = {"id": "two", "title": "Two", "status": "running", "startedAt": 1}
    data["agents"] = [{"id": "explorer", "name": "Explorer", "status": "done", "currentTask": "Task one", "startedAt": 1, "taskId": one},
                      {"id": "worker", "name": "Worker", "status": "working", "currentTask": "Old file", "startedAt": 1}]
    pathlib.Path(folder, "state.json").write_text(json.dumps(data), encoding="utf-8")
    run(folder, "heartbeat")
    agents = {a["name"]: a for a in state(folder)["agents"]}
    check("idle rule: a state of another task reads as idle", agents["Explorer"]["status"] == "idle" and agents["Explorer"]["currentTask"] == "")
    check("idle rule: an old state without a task id is this task's", agents["Worker"]["status"] == "working")
    # Side work: logged with its mark.
    run(folder, "event", "dispatch", "--from", "orchestrator", "--to", "explorer", "--text", "Other repo", "--side")
    check("side: a dispatch for another task is marked", events(folder)[-1].get("side") is True and events(folder)[-1].get("taskId") == "two")

with tempfile.TemporaryDirectory() as folder:
    # Control characters never reach the files: an escape sequence is dropped, whitespace still folds.
    run(folder, "task", "start", "--title", "Fix\x1b[31m the\theader\x9b2J\nnow\x07")
    title = state(folder)["task"]["title"]
    check("clip: control characters dropped, whitespace folded", title == "Fix[31m the header2J now", repr(title))

# The hand-in words: the same cases as the plugin's test (tests/mission.test.tsx).
spec = __import__("importlib.util").util.spec_from_file_location("mc", CLI)
mc = __import__("importlib.util").util.module_from_spec(spec)
spec.loader.exec_module(mc)
hands_in = ["Done", "done: all pass", "PASS with 4 lows", "FAIL: 6 items", "Finished the docs", "Handing in the fix",
            "Report: all pass", "Final-ready", "Final\u2013ok", "Final\u2014ok", "report:x"]
progress = ["Report line fixed", "Final checks running", "Reporting progress", "Donezo", "Final", "Report",
            "Final :PASS", "Final - ready", "Final check: PASS"]
wrong = [line for line in hands_in if not mc.HAND_IN.match(line)] + [line for line in progress if mc.HAND_IN.match(line)]
check("hand-in words: Final and Report only with :, -, \u2013 or \u2014 right after the word", not wrong, ", ".join(wrong))

sys.exit(1 if failures else 0)
