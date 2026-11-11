# Mission Control

A side panel for Claude Code that shows one orchestrator session and its helper agents: the task, its plan, and each agent's status.

<p align="center">
  <img src="docs/screenshot.png" alt="Mission Control's overview in the dark theme, with sample data" width="360">
</p>

## What you see

- The current task and its plan, step by step.
- Each agent's status: idle, queued, working, in review, needs you, or done.
- An activity log of every brief, report and progress line.
- A text version of the same panel in the terminal.

## Install

```
/plugin install mission-control --marketplace ammadbaig/mission-control
```

In the desktop app: + next to the prompt box, Plugins, Add marketplace `ammadbaig/mission-control`, then Add plugin. Restart Claude Code and type `/mission`.

## Set up

- It works best with one orchestrator session and four helpers: Explorer, Worker, Tester and Security.
- Ready-made helper files are in [examples/agents/](examples/agents/).
- Once the plugin is installed, the orchestrator reports to the panel by itself.

## Good to know

- Statuses update by themselves. Needs you shows about a second after a helper's permission prompt, when the plugin is loaded in that helper's session.
- Everything stays on your machine, in `~/.claude/mission-control/`.
- Windows is untested.

The [full guide](docs/guide.md) covers setup in depth, commands, the data files, privacy, troubleshooting and development.

## License

MIT, Ammad Ahmed. See [LICENSE](LICENSE).
