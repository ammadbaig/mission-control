"""The lists the package names in several places, checked against one source: the plugin's writer.

Run: python3 tests/check-lists.py. It fails when the CLI accepts a different list from the plugin,
or when the README, the skill or the contract leaves out an event type, a status or an update kind.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
writer = (ROOT / "hooks/mission/writer.ts").read_text(encoding="utf-8")
model = (ROOT / "hooks/mission/model.ts").read_text(encoding="utf-8")
cli = (ROOT / "cli/mc.py").read_text(encoding="utf-8")
docs = {name: (ROOT / name).read_text(encoding="utf-8") for name in ("README.md", "skills/mission-control/SKILL.md", "hooks/mission/contract.ts")}


def ts_list(source, name):
    body = re.search(r"\b%s\b[^=]*=\s*\[([^\]]*)\]" % name, source)
    return [item for item in re.findall(r"'([^']+)'", body.group(1))] if body else None


def py_list(name):
    body = re.search(r"^%s = \(([^)]*)\)" % name, cli, re.M)
    return re.findall(r'"([^"]+)"', body.group(1)) if body else None


problems = []
lists = {
    "EVENT_TYPES": ts_list(writer, "EVENT_TYPES"),
    "AGENT_STATUSES": ts_list(writer, "AGENT_STATUSES"),
    "ORCH_STATUSES": ts_list(writer, "ORCH_STATUSES"),
    "STEP_STATUSES": ts_list(writer, "STEP_STATUSES"),
    "TASK_STATUSES": ts_list(model, "TASK_STATUSES"),
    "REPORT_KINDS": ts_list(writer, "REPORT_KINDS"),
}
for name, items in lists.items():
    if not items:
        problems.append("could not read %s from the plugin" % name)
        continue
    if name != "REPORT_KINDS" and py_list(name) != items:
        problems.append("%s: the CLI has %s, the plugin %s" % (name, py_list(name), items))
    for doc, text in docs.items():
        # The contract takes its event types and statuses from the writer itself.
        if doc.endswith("contract.ts") and name in ("EVENT_TYPES", "AGENT_STATUSES", "ORCH_STATUSES", "STEP_STATUSES"):
            continue
        if doc.endswith("contract.ts") and name == "TASK_STATUSES":
            continue
        if doc.endswith("contract.ts") and "${list(QUEUE_KINDS)}" in text:
            # The contract names the queue updates from the writer's own list.
            items = [item for item in items if not item.startswith("queue.")]
        missing = [item for item in items if not re.search(r"(?<![\w.])%s(?![\w])" % re.escape(item), text)]
        if missing:
            problems.append("%s leaves out %s: %s" % (doc, name, ", ".join(missing)))

if problems:
    print("\n".join(problems))
    sys.exit(1)
print("lists agree: %s" % ", ".join("%s (%d)" % (name, len(items or [])) for name, items in lists.items()))
