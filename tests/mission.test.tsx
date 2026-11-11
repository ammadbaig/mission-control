import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { questionOf } from '../hooks/mission/auto'
import { HAND_IN } from '../hooks/mission/io'
import { turnOf } from '../hooks/mission/transcript'
import { activityLines, overviewLines, plainOf } from '../hooks/mission/term'
import { baseline, cellsOf } from '../hooks/mission/text'
import { activitySummary, legendOf, SECTION_GAP, timeline, ORCH_CLEAR, orchCircleFor, ORCH_ROOM, orchRoomOf, ORCH_SIZES, orchWordWidth } from '../hooks/mission/draw'
import { ORCH_DISC_R, orchestratorNode } from '../hooks/mission/icons'
import { DARK, LIGHT } from '../hooks/mission/tokens'
import { isOffline, OFFLINE_MS, ORCH_LABELS, orchestratorOf, type McAgent, type McEvent, type McState, type MissionData } from '../hooks/mission/model'
import { apply, emptyState, turnState, type Report } from '../hooks/mission/writer'

const PANE = {
  plugin: 'mission-control',
  component: 'Pane',
  requestId: 'mission-control',
  props: {
    title: 'Mission Control',
    isFocused: false,
    bodyColumns: 52,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const TOOL = 'mcp__mission-control__report'
const DIR = 'C:\\Users\\someone'

/**
 * The engine beneath the plugin, in memory: a Windows-style home folder, a file system of a map,
 * the pane placed and the cell already measured (20px). Answers every call on `$` the plugin makes.
 * A host that isn't Windows takes `C:/...` for a relative path and puts its working folder in
 * front, so files are kept from `C:/` on.
 */
function engine(on: On, options: { eventsUnreadable?: boolean; appData?: boolean; transcriptAge?: { ms: number }; unmeasured?: boolean } = {}): { files: Map<string, string>; clock: MockClock } {
  const files = new Map<string, string>()
  const at = (path: string) => path.slice(Math.max(0, path.indexOf('C:/')))
  // Each write moves the file's change time, as a disk does (its length alone may not change).
  const writes = new Map<string, number>()
  const clock = mock.clock(on, { now: Date.UTC(2026, 0, 1, 9) })
  mock.store(on)
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? DIR : e.name === 'APPDATA' && options.appData ? `${DIR}\\AppData\\Roaming` : undefined }))
  on('session.id', () => ({ value: 'cli-orch' }))
  // `tail -c <bytes> <path>`: the whole fake file is short enough to be its own tail.
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: files.get(at(String(e.argv.at(-1)))) ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_, e) => {
    if (options.eventsUnreadable && e.path.endsWith('events.jsonl')) throw new Error('EBUSY')
    const text = files.get(at(e.path))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(at(e.path), e.text)
    writes.set(at(e.path), (writes.get(at(e.path)) ?? 0) + 1)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: files.has(at(e.path)) || [...files.keys()].some(key => key.startsWith(`${at(e.path)}/`)) }))
  // A folder's entries, from the files under it.
  on('fs.list', (_, e) => {
    const base = `${at(e.path)}/`
    const seen = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [key, text] of files) {
      if (!key.startsWith(base)) continue
      const [name = '', ...deeper] = key.slice(base.length).split('/')
      seen.set(name, { name, kind: deeper.length > 0 ? 'dir' : 'file', size: text.length, mtimeMs: deeper.length > 0 ? 0 : clock.now() - 1000 + (writes.get(key) ?? text.length) % 1000, isLink: false })
    }
    return { value: [...seen.values()] }
  })
  on('fs.stat', (_, e) => {
    const text = files.get(at(e.path))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    // A transcript was written just now (the plugin's quiet limit looks at its age); the data files by a counter.
    const age = options.transcriptAge?.ms ?? 1000
    const mtimeMs = at(e.path).includes('/projects/') ? clock.now() - age + (text.length % 1000) : (writes.get(at(e.path)) ?? text.length)
    return { value: { kind: 'file', size: text.length, mtimeMs, isLink: false } }
  })
  // The pane's cell already measured (20px), unless a test measures it itself.
  if (!options.unmeasured) on('state.get', (_, e, next) => (e.key === 'missionCell' ? { value: { value: 20, version: 1 } } : next(e)))
  on('command.register', () => ({ value: { command: 'mission' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { files, clock }
}

const STATE = 'C:/Users/someone/.claude/mission-control/state.json'
const EVENTS = 'C:/Users/someone/.claude/mission-control/events.jsonl'

test('a report lands in the home folder and the pane draws it, on every surface', async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const answer = await $.tool.call({
    tool: TOOL,
    updates: [
      { do: 'task.start', title: 'Try the pane' },
      { do: 'plan.set', steps: ['Find', 'Fix', 'Verify'] },
      { do: 'agent', name: 'Explorer', status: 'working', task: 'Looking around' },
      { do: 'event', type: 'dispatch', from: 'Orchestrator', to: 'Explorer', text: 'Look around' },
      { do: 'orch', status: 'waiting', waitingOn: ['Explorer'] },
    ],
  } as never)
  expect(answer.deny).toBeUndefined()

  const state = JSON.parse(files.get(STATE) ?? 'null')
  expect(state.task.title).toBe('Try the pane')
  expect(state.plan.map((step: { status: string }) => step.status)).toEqual(['active', 'pending', 'pending'])
  expect(state.agents[0].status).toBe('working')
  expect(files.get(EVENTS)).toContain('"type":"dispatch"')

  // The reader's next second.
  await clock.advance(1000)
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const pictures = await desktop.findAll({ type: 'Svg' })
  expect(pictures.length).toBeGreaterThan(2)
  const alts = pictures.map(found => String(found.props.alt))
  expect(alts).toContain('Mission Control, live')
  expect(alts.some(alt => alt.includes('Try the pane'))).toBe(true)
  expect(await desktop.find({ key: 'mission-open-activity' })).toBeDefined()
  await desktop.press({ key: 'mission-open-activity' })
  expect(await desktop.find({ key: 'mission-back' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The terminal draws the text pane: its title, and no drawing at all.
  expect(await terminal.find({ type: 'Text', text: /^(Mission Control|Activity)$/ })).toBeDefined()
  expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
  await terminal.unmount()
})

test('a bad update stops the list and says which', async ($, on) => {
  const { files } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const answer = await $.tool.call({
    tool: TOOL,
    updates: [
      { do: 'task.start', title: 'One' },
      { do: 'agent', name: 'Worker', status: 'sleeping' },
      { do: 'task.done' },
    ],
  } as never)
  expect(answer.deny).toContain('update 2 (agent)')
  expect(JSON.parse(files.get(STATE) ?? 'null').task.status).toBe('running')
})

test('the heartbeat keeps a running task fresh, and stops when it is done', async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const updated = () => JSON.parse(files.get(STATE) ?? 'null').lastUpdated as number

  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Long one' }] } as never)
  const started = updated()
  await clock.advance(20_000)
  expect(updated()).toBeGreaterThan(started)

  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.done' }] } as never)
  const finished = updated()
  await clock.advance(40_000)
  expect(updated()).toBe(finished)
})

test('an agent with no part is idle, and says so, on every surface', async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // Last task's agents, then a new task: everyone starts idle, with nothing left on their cards.
  await $.tool.call({
    tool: TOOL,
    updates: [
      { do: 'task.start', title: 'Old task' },
      { do: 'agent', name: 'Security', status: 'queued', task: 'Waiting for the packaged plugin' },
      { do: 'agent', name: 'Explorer', status: 'done', task: 'Found it' },
      { do: 'task.done' },
      { do: 'task.start', title: 'New task' },
      { do: 'agent', name: 'Worker', status: 'working', task: 'Changing the redirect' },
      { do: 'agent', name: 'Tester', status: 'queued', task: 'Waits for the fix to verify it' },
      { do: 'agent', name: 'Reviewer', status: 'idle' },
    ],
  } as never)
  const agents = JSON.parse(files.get(STATE) ?? 'null').agents as { name: string; status: string; currentTask: string }[]
  const byName = Object.fromEntries(agents.map(agent => [agent.name, agent]))
  expect(byName.Security).toMatchObject({ status: 'idle', currentTask: '' })
  expect(byName.Explorer).toMatchObject({ status: 'idle', currentTask: '' })
  expect(byName.Reviewer?.status).toBe('idle')
  expect(byName.Tester?.status).toBe('queued')

  await clock.advance(1000)
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const agentsPicture = (await desktop.findAll({ type: 'Svg' })).find(found => String(found.props.alt).startsWith('Agents.'))
  expect(String(agentsPicture?.props.alt)).toBe('Agents. Explorer: idle, Worker: working, Tester: queued, Security: idle')
  const svg = String(agentsPicture?.props.source)
  expect(svg).toContain('>No part in this task<')
  expect(svg).toContain('>IDLE<')
  // Every reported agent is counted, the unseated Reviewer too.
  expect(svg).toContain('3 IDLE')
  expect(svg).toContain('1 QUEUED')
  expect(svg).toContain('AGENTS +1')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The terminal draws the text pane: its title, and no drawing at all.
  expect(await terminal.find({ type: 'Text', text: /^(Mission Control|Activity)$/ })).toBeDefined()
  expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
  await terminal.unmount()
})

test('with no task, every seat is idle and waiting for a task', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const agentsPicture = (await desktop.findAll({ type: 'Svg' })).find(found => String(found.props.alt).startsWith('Agents.'))
  expect(String(agentsPicture?.props.alt)).toBe('Agents. Explorer: idle, Worker: idle, Tester: idle, Security: idle')
  expect(String(agentsPicture?.props.source)).toContain('Waiting for a task')
  expect(String(agentsPicture?.props.source)).toContain('4 IDLE')
  await desktop.unmount()
})

/** Sample data for the legend: a running task and these agents. */
const withAgents = (agents: [string, McAgent['status']][]): MissionData => ({
  loaded: true,
  state: {
    task: { id: 't', title: 'Sample', status: 'running', startedAt: 0 },
    plan: null,
    queue: [],
    agents: agents.map(([name, status]) => ({ id: name.toLowerCase(), name, status, currentTask: '', startedAt: 0 })),
    orchestrator: { status: 'waiting', waitingOn: [], reviewing: [] },
    lastUpdated: 1,
  },
  events: [],
  eventCount: 0,
  fresh: [],
  readAt: 1,
  offline: false,
})

/** The seven agents of the all-states demo: every state at once. */
export const ALL_STATES: [string, McAgent['status']][] = [
  ['Explorer', 'done'],
  ['Worker', 'working'],
  ['Tester', 'in_review'],
  ['Security', 'needs_user'],
  ['Reviewer', 'working'],
  ['Writer', 'queued'],
  ['Scout', 'idle'],
]

test('the legend hides zero counts but ACTIVE, and wraps to a second row when it must', () => {
  const words = (rows: { word: string; count: number }[][]) => rows.map(row => row.map(entry => `${entry.count} ${entry.word}`))

  // Four agents, three states: one row, no zero counts but ACTIVE.
  const four = legendOf(withAgents([['Explorer', 'done'], ['Worker', 'done'], ['Tester', 'in_review'], ['Security', 'idle']]))
  expect(words(four.rows)).toEqual([['0 ACTIVE', '1 IN REVIEW', '2 DONE', '1 IDLE']])
  expect(four.rowWidths[0]).toBeLessThanOrEqual(four.room[0] ?? 0)

  // Every state at once, seven agents: two rows, in order, counts of all seven.
  const all = legendOf(withAgents(ALL_STATES))
  expect(all.title).toBe('AGENTS +3')
  expect(words(all.rows).flat()).toEqual(['2 ACTIVE', '1 IN REVIEW', '1 NEEDS YOU', '1 DONE', '1 QUEUED', '1 IDLE'])
  expect(all.rows).toHaveLength(2)
  expect(all.rowWidths[0]).toBeLessThanOrEqual(all.room[0] ?? 0)
  expect(all.rowWidths[1]).toBeLessThanOrEqual(all.room[1] ?? 0)
})

test('the writer keeps a bad state file, refuses what would lose work, and caps sizes', async ($, on) => {
  const { files } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const call = (updates: unknown[]) => $.tool.call({ tool: TOOL, updates } as never)

  // A state.json cut short is kept as state.json.bad, and the tool says so.
  files.set(STATE, '{"task": {"id": "t1", "title": "Half')
  const kept = await call([{ do: 'task.start', title: 'Fresh' }])
  expect(String(kept.result)).toContain('state.json.bad')
  expect(files.get(`${STATE}.bad`)).toBe('{"task": {"id": "t1", "title": "Half')

  // Promoting while a task runs is refused; it would drop the running task.
  await call([{ do: 'queue.add', text: 'Next one' }])
  expect((await call([{ do: 'queue.promote' }])).deny).toContain('a task is still running')
  await call([{ do: 'task.done' }])
  expect((await call([{ do: 'queue.promote' }])).deny).toBeUndefined()
  expect(JSON.parse(files.get(STATE) ?? 'null').task.title).toBe('Next one')

  // Steps count from 1, as the CLI counts them; 0 is refused.
  await call([{ do: 'plan.set', steps: ['Find', 'Fix'] }])
  expect((await call([{ do: 'plan.step', step: 0, status: 'active' }])).deny).toContain('number from 1 to 2')

  // Caps: 12 steps, 50 updates per call.
  const thirteen = Array.from({ length: 13 }, (_, index) => `S${index}`)
  expect((await call([{ do: 'plan.set', steps: thirteen }])).deny).toContain('at most 12 steps')
  const many = Array.from({ length: 51 }, () => ({ do: 'heartbeat' }))
  expect((await call(many)).deny).toContain('at most 50 updates')
})

test('an unreadable event log is left as it was', async ($, on) => {
  const { files } = engine(on, { eventsUnreadable: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  files.set(EVENTS, '{"time":1,"type":"report","from":"A","to":"B","text":"old"}\n')
  const answer = await $.tool.call({
    tool: TOOL,
    updates: [{ do: 'event', type: 'dispatch', from: 'Orchestrator', to: 'Explorer', text: 'new' }],
  } as never)
  expect(String(answer.result)).toContain('events.jsonl could not be read')
  expect(files.get(EVENTS)).toBe('{"time":1,"type":"report","from":"A","to":"B","text":"old"}\n')
})

test('a hand-in shows as in review until the orchestrator accepts it, on every surface', async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const call = (updates: unknown[]) => $.tool.call({ tool: TOOL, updates } as never)
  await call([
    { do: 'task.start', title: 'Check the build' },
    { do: 'agent', name: 'Tester', status: 'working', task: 'Running the checks' },
    { do: 'agent', name: 'Tester', status: 'in_review', task: 'Reported: 6 checks failed' },
    { do: 'event', type: 'report', from: 'Tester', to: 'Orchestrator', text: '6 checks failed' },
    { do: 'orch', status: 'reviewing', reviewing: ['Tester'] },
  ])
  const state = JSON.parse(files.get(STATE) ?? 'null')
  expect(state.orchestrator).toMatchObject({ status: 'reviewing', waitingOn: [], reviewing: ['Tester'] })
  expect(state.agents[0]).toMatchObject({ status: 'in_review', currentTask: 'Reported: 6 checks failed' })

  await clock.advance(1000)
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const picture = (await desktop.findAll({ type: 'Svg' })).find(found => String(found.props.alt).startsWith('Agents.'))
  expect(String(picture?.props.alt)).toContain('Tester: in review')
  const svg = String(picture?.props.source)
  expect(svg).toContain('>IN REVIEW<')
  expect(svg).toContain('1 IN REVIEW')
  expect(svg).toContain('>REVIEWING<')
  expect(svg).toContain('Reported: 6 checks')
  // The pink, in dark and in light; and no timer on the card (the agent is not working).
  expect(svg).toContain('#FF7AC6')
  expect(svg).toContain('#A8248A')
  expect(svg).not.toContain('NEEDS YOU')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The terminal draws the text pane: its title, and no drawing at all.
  expect(await terminal.find({ type: 'Text', text: /^(Mission Control|Activity)$/ })).toBeDefined()
  expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
  await terminal.unmount()

  // Accepted: done, and the orchestrator no longer reviewing.
  await call([
    { do: 'agent', name: 'Tester', status: 'done', task: 'Six failures found and listed' },
    { do: 'orch', status: 'waiting', waitingOn: ['Worker'] },
  ])
  const after = JSON.parse(files.get(STATE) ?? 'null')
  expect(after.agents[0].status).toBe('done')
  expect(after.orchestrator.reviewing).toEqual([])
})

test('an old state file without reviewing still reads', async ($, on) => {
  const { files } = engine(on)
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  files.set(STATE, JSON.stringify({ task: null, plan: null, queue: [], agents: [], orchestrator: { status: 'waiting', waitingOn: ['Worker'] }, lastUpdated: 1 }))
  const answer = await $.tool.call({ tool: TOOL, updates: [{ do: 'heartbeat' }] } as never)
  expect(String(answer.result)).not.toContain('state.json.bad')
  // Read with its missing list filled in; stored as its agents and its turn show it: working while
  // its turn runs, then idle (none works, no task).
  expect(JSON.parse(files.get(STATE) ?? 'null').orchestrator).toMatchObject({ status: 'working', waitingOn: [], reviewing: [] })
  await $.classic.Stop({ stop_hook_active: false } as never)
  expect(JSON.parse(files.get(STATE) ?? 'null').orchestrator).toMatchObject({ status: 'idle', waitingOn: [], reviewing: [] })
  expect(JSON.parse(files.get(STATE) ?? 'null').orchestrator.turn).toBeUndefined()
})

test('every state at once: the legend wraps, the counts match, on every surface', async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    updates: [{ do: 'task.start', title: 'Every state' }, ...ALL_STATES.map(([name, status]) => ({ do: 'agent', name, status, task: `${name} line` }))],
  } as never)
  expect(JSON.parse(files.get(STATE) ?? 'null').agents).toHaveLength(7)
  await clock.advance(1000)
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const picture = (await desktop.findAll({ type: 'Svg' })).find(found => String(found.props.alt).startsWith('Agents.'))
  const svg = String(picture?.props.source)
  for (const item of ['AGENTS +3', '2 ACTIVE', '1 IN REVIEW', '1 NEEDS YOU', '1 DONE', '1 QUEUED', '1 IDLE']) expect(svg).toContain(`>${item}<`)
  await desktop.unmount()
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The terminal draws the text pane: its title, and no drawing at all.
  expect(await terminal.find({ type: 'Text', text: /^(Mission Control|Activity)$/ })).toBeDefined()
  expect(await terminal.findAll({ type: 'Svg' })).toHaveLength(0)
  await terminal.unmount()
})

test("a helper adds only its own lines, and the panel shows them under its name", async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const orchestrate = (updates: unknown[]) => $.tool.call({ tool: TOOL, updates } as never)
  const helper = (as: string, updates: unknown[]) => $.tool.call({ tool: TOOL, as, updates } as never)
  await orchestrate([
    { do: 'task.start', title: 'Check the build' },
    { do: 'agent', name: 'Tester', status: 'working', task: 'Running the visual tests' },
    { do: 'event', type: 'dispatch', from: 'Orchestrator', to: 'Tester', text: 'Run the visual tests' },
  ])
  const state = files.get(STATE)

  // A helper cannot touch the task, plan, queue or any status.
  const refused = await helper('tester', [{ do: 'agent', name: 'Tester', status: 'done' }])
  expect(refused.deny).toContain('a helper may only add its own lines')
  expect(files.get(STATE)).toBe(state)

  // Its own lines: from its role whatever it writes, and state.json untouched.
  expect((await helper('tester', [{ do: 'say', text: 'Started: 20 screens to compare' }])).deny).toBeUndefined()
  await clock.advance(2000)
  await helper('tester', [{ do: 'say', text: 'Dropped: within five seconds' }])
  await clock.advance(4000)
  await helper('tester', [{ do: 'say', text: 'Found: 2 screens differ, Wallet and Payout' }])
  await helper('worker', [{ do: 'say', text: 'Reading the payout dialogue' }])
  // Only its own card moves: the Tester was already working, so its card is as it was; the Worker's
  // first line starts it.
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'working', currentTask: 'Running the visual tests' })
  expect(agentOf(files, 'Worker')).toMatchObject({ status: 'working', currentTask: 'Reading the payout dialogue' })
  expect(JSON.parse(files.get(STATE) ?? 'null').task.title).toBe(JSON.parse(state ?? 'null').task.title)
  const log = (files.get(EVENTS) ?? '').trim().split('\n').map(line => JSON.parse(line) as { type: string; from: string; text: string })
  expect(log.map(event => `${event.type} ${event.from}: ${event.text}`)).toEqual([
    'dispatch orchestrator: Run the visual tests',
    'progress tester: Started: 20 screens to compare',
    'progress tester: Found: 2 screens differ, Wallet and Payout',
    'progress worker: Reading the payout dialogue',
  ])

  await clock.advance(1000)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /^(Mission Control|Activity)$/ })).toBeDefined()
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
      await ui.unmount()
      continue
    }
    const pictures = await ui.findAll({ type: 'Svg' })
    // The latest-update row shows the newest event of any kind: here an agent's.
    expect(pictures.some(found => String(found.props.alt).startsWith('Latest update from Worker'))).toBe(true)
    // The working Tester's card: the orchestrator's task, then its own newest line, quieter.
    const agents = String(pictures.find(found => String(found.props.alt).startsWith('Agents.'))?.props.source)
    expect(agents).toContain('Running the')
    expect(agents).toContain('Found: 2 screens')
    await ui.press({ key: 'mission-open-activity' })
    const timelinePicture = (await ui.findAll({ type: 'Svg' })).find(found => String(found.props.alt).includes('events, newest first'))
    const tl = String(timelinePicture?.props.source)
    // Tester's two lines share one heading, as Worker's one line has one: the same count of each
    // name (the drawing carries both themes, so each heading is there once per theme).
    const headings = (name: string) => tl.split(`>${name}<`).length - 1
    expect(headings('Worker')).toBeGreaterThan(0)
    expect(headings('Tester')).toBe(headings('Worker'))
    await ui.unmount()
  }
})

/** The drawings' sources on the desktop, joined, and their alts. */
async function drawn($: Engine): Promise<{ svg: string; alts: string[] }> {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const pictures = await ui.findAll({ type: 'Svg' })
  await ui.unmount()
  return { svg: pictures.map(found => String(found.props.source)).join('\n'), alts: pictures.map(found => String(found.props.alt)) }
}

test('a paused task shows as paused, never offline, and resumes live', async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const call = (updates: unknown[]) => $.tool.call({ tool: TOOL, updates } as never)
  await call([
    { do: 'task.start', title: 'Ship the fix' },
    { do: 'plan.set', steps: ['Find', 'Fix', 'Verify'] },
    { do: 'plan.step', step: 'Fix', status: 'active' },
    { do: 'agent', name: 'Worker', status: 'working', task: 'Changing the redirect' },
    { do: 'task.pause', reason: 'Waiting for the owner' },
  ])
  expect(JSON.parse(files.get(STATE) ?? 'null').task).toMatchObject({ status: 'paused', pauseReason: 'Waiting for the owner' })
  // Two minutes with no heartbeat: still paused, not offline.
  await clock.advance(120_000)
  const paused = await drawn($)
  expect(paused.alts).toContain('Mission Control, paused')
  expect(paused.svg).toContain('>PAUSED<')
  expect(paused.svg).toContain('>PAUSED AT FIX<')
  expect(paused.svg).not.toContain('OFFLINE')
  expect(paused.alts.some(alt => alt.startsWith('Latest update from Orchestrator') && alt.includes('Paused: Waiting for the owner'))).toBe(true)

  await call([{ do: 'task.resume' }])
  await clock.advance(1000)
  expect((await drawn($)).alts).toContain('Mission Control, live')
})

test('a running task gone quiet is offline: the last known state, clearly old', async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Written by a session that has since stopped: a running task, last heard of 70 seconds ago.
  const then = clock.now() - 70_000
  files.set(
    STATE,
    JSON.stringify({
      task: { id: 't', title: 'Long job', status: 'running', startedAt: then - 60_000 },
      plan: null,
      queue: [],
      agents: [{ id: 'tester', name: 'Tester', status: 'working', currentTask: 'Running the tests', startedAt: then - 30_000 }],
      orchestrator: { status: 'waiting', waitingOn: ['Tester'], reviewing: [] },
      lastUpdated: then,
    }),
  )
  await clock.advance(1000)
  const offline = await drawn($)
  expect(offline.alts).toContain('Mission Control, offline')
  expect(offline.alts.some(alt => alt.startsWith('No update since ') && alt.endsWith('showing the last known state'))).toBe(true)
  expect(offline.svg).toContain('LAST SEEN')
  expect(offline.svg).toContain('LAST KNOWN')
  // Nothing moves offline but the orchestrator's ring, which always turns.
  expect(offline.svg.replace(/class="m spin( fast)?"/g, '')).not.toMatch(/class="m [a-z]/)
})

test('no task is idle, not offline, and an idle agent keeps no old words', async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const call = (updates: unknown[]) => $.tool.call({ tool: TOOL, updates } as never)
  await call([
    { do: 'task.start', title: 'Short job' },
    { do: 'agent', name: 'Explorer', status: 'working', task: 'Waiting for the packaged plugin' },
    { do: 'agent', name: 'Explorer', status: 'idle' },
    { do: 'task.done' },
  ])
  expect(JSON.parse(files.get(STATE) ?? 'null').agents[0]).toMatchObject({ status: 'idle', currentTask: '' })
  await clock.advance(120_000)
  const idle = await drawn($)
  expect(idle.alts).toContain('Mission Control, idle')
  expect(idle.svg).toContain('>IDLE<')
  expect(idle.svg).not.toContain('OFFLINE')
  expect(idle.svg).not.toContain('Waiting for the packaged plugin')
})

/** The log as `type from>to: text` lines. */
const logOf = (files: Map<string, string>) =>
  (files.get(EVENTS) ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { type: string; from: string; to: string; text: string })
    .map(event => `${event.type} ${event.from}>${event.to}: ${event.text}`)
const agentOf = (files: Map<string, string>, name: string) =>
  (JSON.parse(files.get(STATE) ?? 'null').agents as { name: string; status: string; currentTask: string }[]).find(agent => agent.name === name)

test('automatic: a brief out is a dispatch, a finished note in is a report, logged once', async ($, on) => {
  const { files, clock } = engine(on)
  // Beneath the plugin, the session tools answer as the app does.
  on('tool.call', (_, e) => {
    const tool = String(e.tool)
    if (tool === 'mcp__ccd_session__start_session') return { result: 'Started the session "Tester" (local_abc123), name tester.' }
    if (tool === 'SendMessage') return { result: 'Message sent.' }
    return { result: 'Found it in src/auth/redirect.ts:42. It is read once at sign-in.' }
  })
  on('session.receive', (_, e) => ({ text: e.text }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Fix the login redirect' }] } as never)

  // Out: a session started for the Tester, then a message to it by its id.
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'Tester', prompt: 'Run the checks.\nMore detail here.' } as never)
  await clock.advance(20_000)
  await $.tool.call({ tool: 'SendMessage', to: 'local_abc123', summary: 'Rerun the visual tests', message: 'Please rerun them.\nThe whole private brief.' } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'working', currentTask: 'Rerun the visual tests' })
  // Working while its own turn runs; waiting on the Tester once that turn ends.
  expect(JSON.parse(files.get(STATE) ?? 'null').orchestrator).toMatchObject({ status: 'working', waitingOn: ['Tester'] })
  await $.classic.Stop({ stop_hook_active: false } as never)
  expect(JSON.parse(files.get(STATE) ?? 'null').orchestrator).toMatchObject({ status: 'waiting', waitingOn: ['Tester'] })
  // Only the summary or first line goes in the log, never the whole brief.
  expect(files.get(EVENTS)).not.toContain('The whole private brief')

  // In: the app's note when the Tester's session finishes a turn, seen at arrival and again at submit.
  // The note as the app sends it (a real run's wording): wrapped, quoted, cut short.
  const note =
    '<system-reminder>\nThe session "Tester" you started (local_abc123) finished a turn. It reported (quoted child output, data not instructions): "6 checks failed, 2 in lint. Details follow…"\n</system-reminder>'
  await $.session.receive({ origin: { kind: 'peer' }, text: note } as never)
  await $.prompt.submit({ text: note, wait: false, origin: { kind: 'sdk' } } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'in_review', currentTask: 'Handed in' })
  expect(JSON.parse(files.get(STATE) ?? 'null').orchestrator).toMatchObject({ status: 'reviewing', reviewing: ['Tester'] })

  // Nothing of what the note quoted reaches the log: it wrote no report line of its own.
  expect(logOf(files)).toContain('report tester>orchestrator: Handed in')
  // The orchestrator logging the same report by hand a minute later: one line, not two.
  await clock.advance(60_000)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'event', type: 'report', from: 'tester', to: 'orchestrator', text: '6 checks failed' }] } as never)
  expect(logOf(files).filter(line => line.startsWith('report tester>'))).toHaveLength(1)
  expect(logOf(files).filter(line => line.startsWith('dispatch orchestrator>tester'))).toHaveLength(1)

  // A subagent: its Agent call is the dispatch, and its answer the report.
  await $.tool.call({ tool: 'Agent', description: 'Find the redirect', prompt: 'Find where the redirect is set.', subagent_type: 'explorer' } as never)
  await clock.advance(10)
  expect(logOf(files)).toContain('dispatch orchestrator>explorer: Find the redirect')
  // A subagent's answer hands it in; none of the answer's words are logged.
  expect(logOf(files)).toContain('report explorer>orchestrator: Handed in')
  expect(logOf(files)).not.toContain('redirect.ts:42')
  expect(agentOf(files, 'Explorer')?.status).toBe('in_review')
})

test('automatic: the orchestrator decides what needs judgement, and can switch it off', async ($, on) => {
  const { files, clock } = engine(on)
  on('tool.call', () => ({ result: 'Message sent.' }))
  on('session.receive', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Ship it' }] } as never)
  await $.tool.call({ tool: 'SendMessage', to: 'worker', summary: 'Make the change', message: 'Make it.' } as never)
  await clock.advance(10)
  // The orchestrator sends it back by hand after the note: its own write stands.
  await $.session.receive({ origin: { kind: 'peer' }, text: 'The session "Worker" you started (local_w1) finished a turn. It reported: done.' } as never)
  await clock.advance(10)
  await clock.advance(5000)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'agent', name: 'Worker', status: 'done', task: 'Accepted' }] } as never)
  expect(agentOf(files, 'Worker')?.status).toBe('done')

  // Switched off: briefs and notes change nothing.
  await $.command.run({ command: 'mission', args: 'auto off', origin: { kind: 'person' }, presentation: { isFullscreen: false } } as never)
  const before = files.get(STATE)
  await $.tool.call({ tool: 'SendMessage', to: 'worker', summary: 'One more', message: 'One more.' } as never)
  await clock.advance(10)
  expect(files.get(STATE)).toBe(before)
  await $.command.run({ command: 'mission', args: 'auto on', origin: { kind: 'person' }, presentation: { isFullscreen: false } } as never)
})

test("a helper's own permission prompt shows NEEDS YOU, and clears itself once answered", async ($, on) => {
  const { files, clock } = engine(on)
  on('tool.call', () => ({ result: 'written' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.PermissionRequest', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The orchestrator's state, as this helper finds it.
  files.set(
    STATE,
    JSON.stringify({
      task: { id: 't', title: 'Audit', status: 'running', startedAt: 1 },
      plan: null,
      queue: [],
      agents: [{ id: 'explorer', name: 'Explorer', status: 'working', currentTask: 'Auditing the instructions', startedAt: 1 }],
      orchestrator: { status: 'waiting', waitingOn: ['Explorer'], reviewing: [] },
      lastUpdated: clock.now(),
    }),
  )
  // This session's brief names its role, so it knows it is the Explorer.
  await $.prompt.submit({ text: 'Audit the instructions. Report progress with: mc.py say --as explorer "..."', wait: false, origin: { kind: 'peer' } } as never)
  await clock.advance(10)
  await $.classic.PermissionRequest({ tool_name: 'Write', tool_input: { file_path: '/notes/instructions-audit.md', content: 'x' } } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Explorer')).toMatchObject({ status: 'needs_user', currentTask: 'Allow or deny: Write instructions-audit.md' })
  expect(logOf(files)).toContain('needs_user explorer>orchestrator: Allow or deny: Write instructions-audit.md')
  // The person answers; the call goes on, and the card is back to its work.
  await $.tool.call({ tool: 'Write', file_path: '/notes/instructions-audit.md', content: 'x' } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Explorer')).toMatchObject({ status: 'working', currentTask: 'Auditing the instructions' })
})

test('automatic: ids from the linked-sessions list map helpers, the manual copy wins, and debug shows calls', async ($, on) => {
  const { files, clock } = engine(on)
  on('tool.call', () => ({ result: 'Message sent.' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Final check' }] } as never)
  await $.command.run({ command: 'mission', args: 'debug on', origin: { kind: 'person' }, presentation: { isFullscreen: false } } as never)

  // The orchestrator's context lists its sessions by name and id: that is how it learns them.
  await $.prompt.submit({ text: 'Linked sessions now:\n- Tester · local_00000000-0000-4000-8000-0000000000a1 · idle', wait: false, origin: { kind: 'sdk' } } as never)
  await clock.advance(10)
  await $.tool.call({ tool: 'SendMessage', to: 'local_00000000-0000-4000-8000-0000000000a1', summary: 'Final check of the package', message: 'Secret brief text.' } as never)
  await clock.advance(10)
  expect(logOf(files)).toContain('dispatch orchestrator>tester: Final check of the package')
  expect(agentOf(files, 'Tester')?.status).toBe('working')

  // The orchestrator logs the same dispatch by hand: its copy replaces the automatic one.
  await $.tool.call({ tool: TOOL, updates: [{ do: 'event', type: 'dispatch', from: 'orchestrator', to: 'tester', text: 'Final check: clean copy' }] } as never)
  expect(logOf(files).filter(line => line.startsWith('dispatch orchestrator>tester'))).toEqual(['dispatch orchestrator>tester: Final check: clean copy'])

  // Debug: the call's name and input keys, the version, never the message.
  const debugFile = files.get('C:/Users/someone/.claude/mission-control/.panel-debug.json') ?? ''
  expect(debugFile).toContain('"version"')
  expect(debugFile).toContain('"SendMessage"')
  expect(debugFile).toContain('"summary"')
  expect(debugFile).not.toContain('Secret brief text')
  await $.command.run({ command: 'mission', args: 'debug off', origin: { kind: 'person' }, presentation: { isFullscreen: false } } as never)
})

test("a helper's own lines move its own card: its first line starts it, its report hands it in", async ($, on) => {
  const { files, clock } = engine(on)
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    updates: [
      { do: 'task.start', title: 'Final check' },
      { do: 'agent', name: 'Security', status: 'queued', task: 'Waits for the fix' },
      { do: 'agent', name: 'Tester', status: 'working', task: 'Running the checks' },
      { do: 'orch', status: 'waiting', waitingOn: ['Tester', 'Security'] },
    ],
  } as never)
  const helper = (as: string, updates: unknown[]) => $.tool.call({ tool: TOOL, as, updates } as never)
  const orchestrator = () => JSON.parse(files.get(STATE) ?? 'null').orchestrator

  // Its first line on the job: queued to working (a missed dispatch cannot leave it looking idle).
  await helper('security', [{ do: 'say', text: 'Starting the final review' }])
  expect(agentOf(files, 'Security')).toMatchObject({ status: 'working', currentTask: 'Waits for the fix' })

  // Its report: in review at once, with the report as its line; nothing else moves.
  await clock.advance(6000)
  await helper('security', [{ do: 'say', type: 'report', text: 'Done: PASS with 4 lows' }])
  expect(agentOf(files, 'Security')).toMatchObject({ status: 'in_review', currentTask: 'Done: PASS with 4 lows' })
  expect(agentOf(files, 'Tester')?.status).toBe('working')
  // The orchestrator's stored status follows its agents: reviewing Security, still waiting on Tester.
  expect(orchestrator()).toMatchObject({ status: 'reviewing', waitingOn: ['Tester'], reviewing: ['Security'] })

  // The note arrives later (the orchestrator's next turn): nothing is logged twice, its line stays.
  await $.prompt.submit({ text: 'The session "Security" you started (local_sec1) finished a turn. It reported: "Done: PASS with 4 lows."', wait: false, origin: { kind: 'sdk' } } as never)
  await clock.advance(10)
  expect(logOf(files).filter(line => line.startsWith('report security>') || line.startsWith('report Security>'))).toHaveLength(1)
  expect(agentOf(files, 'Security')).toMatchObject({ status: 'in_review', currentTask: 'Done: PASS with 4 lows' })

  // From any other state, a report only logs: an idle agent stays idle.
  await helper('worker', [{ do: 'say', type: 'report', text: 'Nothing to do' }])
  expect(agentOf(files, 'Worker')).toBeUndefined()

  // Its next line after a hand-in means a new job: working again, timer restarted, that line its task.
  await clock.advance(6000)
  await helper('security', [{ do: 'say', text: 'Starting the next brief' }])
  expect(agentOf(files, 'Security')).toMatchObject({ status: 'working', currentTask: 'Starting the next brief' })

  // A plain line opening with a hand-in word, from a working agent, is its report.
  await clock.advance(6000)
  await helper('security', [{ do: 'say', text: 'Final: FAIL, 6 items' }])
  expect(agentOf(files, 'Security')).toMatchObject({ status: 'in_review', currentTask: 'Final: FAIL, 6 items' })
  expect(logOf(files)).toContain('report security>orchestrator: Final: FAIL, 6 items')
})

test('no status goes stale: one-step accept and send back, the turn-end guard, the derived orchestrator', async ($, on) => {
  const { files, clock } = engine(on)
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const call = (updates: unknown[]) => $.tool.call({ tool: TOOL, updates } as never)
  await call([
    { do: 'task.start', title: 'Final check' },
    { do: 'agent', name: 'Security', status: 'working', task: 'Reviewing' },
    { do: 'agent', name: 'Tester', status: 'working', task: 'Checking' },
  ])
  await $.tool.call({ tool: TOOL, as: 'security', updates: [{ do: 'say', type: 'report', text: 'PASS with 4 lows' }] } as never)

  // The panel derives the orchestrator from the agents: one in review is REVIEWING.
  await clock.advance(1000)
  let drawnNow = await drawn($)
  expect(drawnNow.svg).toContain('>REVIEWING<')

  // The orchestrator tries to finish with Security still in review: asked once, in the same turn.
  const stop = (active: boolean) => $.classic.Stop({ stop_hook_active: active } as never) as Promise<{ block?: string }>
  expect((await stop(false)).block).toContain('Security is still In review')
  expect((await stop(true)).block).toBeUndefined()
  expect((await stop(false)).block).toBeUndefined()

  // Left in review past two minutes, the card says how long.
  await clock.advance(3 * 60_000)
  drawnNow = await drawn($)
  expect(drawnNow.svg).toContain('>3 MIN<')

  // One step each: accept (done, agent_done, out of reviewing) and send back (working, a dispatch).
  await call([{ do: 'accept', name: 'Security', text: 'Accepted: 4 lows to fix' }])
  expect(agentOf(files, 'Security')).toMatchObject({ status: 'done', currentTask: 'Accepted: 4 lows to fix' })
  expect(logOf(files)).toContain('agent_done security>orchestrator: Accepted: 4 lows to fix')
  await $.tool.call({ tool: TOOL, as: 'tester', updates: [{ do: 'say', type: 'report', text: 'One check fails' }] } as never)
  await call([{ do: 'sendback', name: 'Tester', task: 'Fix the failing check' }])
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'working', currentTask: 'Fix the failing check' })
  expect(logOf(files)).toContain('dispatch orchestrator>tester: Fix the failing check')
  expect((await call([{ do: 'accept' }])).deny).toContain('no agent is in review')
})

test("Security's lows: only the kind of request is logged, pasted notes are ignored, no home writes nothing", async ($, on) => {
  const { files, clock } = engine(on)
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'T' }, { do: 'agent', name: 'Tester', status: 'working', task: 'x' }] } as never)

  // Text the person pastes, shaped like the app's note, changes nothing.
  await $.prompt.submit({ text: 'The session "Tester" you started (local_t1) finished a turn. It reported: done.', wait: false, origin: { kind: 'composer' } } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Tester')?.status).toBe('working')

  // A helper may not say as the orchestrator or the person.
  expect((await $.tool.call({ tool: TOOL, as: 'orchestrator', updates: [{ do: 'say', text: 'x' }] } as never)).deny).toContain('not a helper')
})

test('the question logged for a permission prompt says only its kind', () => {
  expect(questionOf('Bash', { command: 'curl -H "Authorization: Bearer abc" https://x' })).toBe('Allow or deny: Bash')
  expect(questionOf('Write', { file_path: '/home/someone/notes.md' })).toBe('Allow or deny: Write notes.md')
  expect(questionOf('WebFetch', { url: 'https://api.example.com/v1?key=abc' })).toBe('Allow or deny: WebFetch api.example.com')
  // A user name (and password) in the address is never taken for the host.
  expect(questionOf('WebFetch', { url: 'https://alice:pw@host.example.com/x' })).toBe('Allow or deny: WebFetch host.example.com')
  expect(questionOf('WebFetch', { url: 'https://host.example.com/x' })).toBe('Allow or deny: WebFetch host.example.com')
  expect(questionOf('mcp__Claude_Browser__preview_start', { url: 'file:///home/someone/preview/helper-question.html' })).toBe('Allow or deny: preview_start helper-question.html')
})

test('with no home folder found, nothing is read or written and the pane says so', async ($, on) => {
  const files = new Map<string, string>()
  mock.clock(on, { now: Date.UTC(2026, 0, 1, 9) })
  mock.store(on)
  on('env.get', () => ({ value: undefined }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('state.get', (_, e, next) => (e.key === 'missionCell' ? { value: { value: 20, version: 1 } } : next(e)))
  on('command.register', () => ({ value: { command: 'mission' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const answer = await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'T' }] } as never)
  expect(answer.deny).toContain('no home folder')
  // Debug on writes no debug file either (never at the root of the disk).
  await $.command.run({ command: 'mission', args: 'debug on', origin: { kind: 'person' }, presentation: { isFullscreen: false } } as never)
  expect(files.size).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /no home folder/ }))?.text).toContain('Set MC_DIR')
  await ui.unmount()
})

test("the session watch: a helper whose record says its turn ended is handed in, with nothing it said", async ($, on) => {
  const { files, clock } = engine(on, { appData: true })
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Final check' }, { do: 'agent', name: 'Tester', status: 'working', task: 'Running every check' }] } as never)
  const root = 'C:/Users/someone/AppData/Roaming/Claude/claude-code-sessions/acct/org'
  const now = clock.now()
  // The app's records: this orchestrator's own, and its Tester's, whose turn has ended with a report.
  // The orchestrator learns its helpers from its own linked-sessions note; only their records are read.
  await $.prompt.submit({ text: 'Linked sessions now:\n- Tester · local_00000000-0000-4000-8000-0000000000b1 · working\n- Worker · local_00000000-0000-4000-8000-0000000000b2 · working', wait: false, origin: { kind: 'sdk' } } as never)
  const tester = (finished: boolean) =>
    JSON.stringify({
      sessionId: 'local_00000000-0000-4000-8000-0000000000b1',
      title: 'Tester',
      spawnedFrom: { sessionId: 'local_orch' },
      lastAssistantUuid: 'a2',
      postTurnSummaryFor: finished ? 'a2' : 'a1',
      lastTurnEdgeAt: now + 2000,
      latestUserFrameAt: finished ? now - 60_000 : now + 3000,
      lastTurnReport: 'Final check: FAIL on six items. The rest passes.',
    })
  // Still mid-turn: nothing moves.
  files.set(`${root}/local_00000000-0000-4000-8000-0000000000b1.json`, tester(false))
  await clock.advance(4100)
  expect(agentOf(files, 'Tester')?.status).toBe('working')
  // Its turn has ended: in review, with the report's first sentence, within the next look.
  files.set(`${root}/local_00000000-0000-4000-8000-0000000000b1.json`, `${tester(true)} `)
  await clock.advance(4100)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'in_review', currentTask: 'Handed in' })
  expect(logOf(files)).toContain('report tester>orchestrator: Handed in')
  expect(logOf(files)).not.toContain('six items')
})

test("a helper's card follows its transcript: running is working, an ended turn is in review, with nothing it said", async ($, on) => {
  const { files, clock } = engine(on, { appData: true })
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Final check' }, { do: 'agent', name: 'Tester', status: 'queued', task: 'Waits for the fix' }] } as never)
  const root = 'C:/Users/someone/AppData/Roaming/Claude/claude-code-sessions/acct/org'
  // The orchestrator learns its helpers from its own linked-sessions note; only their records are read.
  await $.prompt.submit({ text: 'Linked sessions now:\n- Tester · local_00000000-0000-4000-8000-0000000000b1 · working\n- Worker · local_00000000-0000-4000-8000-0000000000b2 · working', wait: false, origin: { kind: 'sdk' } } as never)
  files.set(`${root}/local_00000000-0000-4000-8000-0000000000b1.json`, JSON.stringify({ sessionId: 'local_00000000-0000-4000-8000-0000000000b1', cliSessionId: 'tst-uuid', cwd: '/work/tester', title: 'Tester', spawnedFrom: { sessionId: 'local_orch' } }))
  const transcript = 'C:/Users/someone/.claude/projects/-work-tester/tst-uuid.jsonl'
  const at = (ms: number) => new Date(clock.now() + ms).toISOString()
  const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`
  // The brief arrives and the turn runs: a long tool call, nothing written for a while.
  files.set(transcript, line({ type: 'user', timestamp: at(1000), message: { content: 'Run every check' } }) + line({ type: 'assistant', timestamp: at(2000), message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } }))
  await clock.advance(5000)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'working', currentTask: 'Waits for the fix' })
  expect(agentOf(files, 'Tester')).toMatchObject({ startedAt: clock.now() - 5000 + 1000 })
  // Its turn ends: in review within a second, with its answer's first sentence.
  files.set(transcript, `${files.get(transcript)}${line({ type: 'user', timestamp: at(100), message: { content: [{ type: 'tool_result' }] } })}${line({ type: 'assistant', timestamp: at(200), message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'PASS: all 25 tests pass. Details below.' }] } })}${line({ type: 'system', subtype: 'stop_hook_summary', timestamp: at(300) })}`)
  await clock.advance(1100)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'in_review', currentTask: 'Handed in' })
  expect(logOf(files)).toContain('report tester>orchestrator: Handed in')
  expect(logOf(files)).not.toContain('all 25 tests')
  // The orchestrator accepts it; the session stays ended, so the card stays done.
  await $.tool.call({ tool: TOOL, updates: [{ do: 'accept', name: 'Tester' }] } as never)
  await clock.advance(11_000)
  expect(agentOf(files, 'Tester')?.status).toBe('done')
  // A new message starts the session again: working at once, from that turn's start.
  files.set(transcript, `${files.get(transcript)}${line({ type: 'user', timestamp: at(0), message: { content: 'One more check' } })}`)
  const began = clock.now()
  await clock.advance(1100)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'working', currentTask: 'Back at work', startedAt: began })
})

test("an ended turn hands in with the helper's own report line when it wrote one for this job", async ($, on) => {
  const { files, clock } = engine(on, { appData: true })
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Fix' }, { do: 'agent', name: 'Worker', status: 'working', task: 'Fixing' }, { do: 'event', type: 'dispatch', from: 'Orchestrator', to: 'Worker', text: 'Fix it' }] } as never)
  // Its report line, then a later line that starts it again (so its card is working once more).
  await $.tool.call({ tool: TOOL, as: 'worker', updates: [{ do: 'say', type: 'report', text: 'Fix in io.ts; 26 tests pass' }] } as never)
  await clock.advance(6000)
  await $.tool.call({ tool: TOOL, as: 'worker', updates: [{ do: 'say', text: 'One last look at the docs' }] } as never)
  expect(agentOf(files, 'Worker')?.status).toBe('working')
  const root = 'C:/Users/someone/AppData/Roaming/Claude/claude-code-sessions/acct/org'
  // The orchestrator learns its helpers from its own linked-sessions note; only their records are read.
  await $.prompt.submit({ text: 'Linked sessions now:\n- Tester · local_00000000-0000-4000-8000-0000000000b1 · working\n- Worker · local_00000000-0000-4000-8000-0000000000b2 · working', wait: false, origin: { kind: 'sdk' } } as never)
  files.set(`${root}/local_00000000-0000-4000-8000-0000000000b2.json`, JSON.stringify({ sessionId: 'local_00000000-0000-4000-8000-0000000000b2', cliSessionId: 'wrk-uuid', cwd: '/work/w', title: 'Worker', spawnedFrom: { sessionId: 'local_orch' } }))
  const answer = { type: 'assistant', timestamp: new Date(clock.now() + 1000).toISOString(), message: { id: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'This is a long story. It ends well.' }] } }
  files.set('C:/Users/someone/.claude/projects/-work-w/wrk-uuid.jsonl', `${JSON.stringify(answer)}\n`)
  await clock.advance(5000)
  expect(agentOf(files, 'Worker')).toMatchObject({ status: 'in_review', currentTask: 'Reported: Fix in io.ts; 26 tests pass' })
})

test('hand-in words: Done, PASS and FAIL hand in; Report and Final only with a colon', () => {
  for (const line of ['Done', 'done: all pass', 'PASS with 4 lows', 'FAIL: 6 items', 'Finished the docs', 'Handing in the fix', 'Report: all pass', 'Final-ready', 'Final–ok', 'Final—ok', 'report:x']) expect(HAND_IN.test(line)).toBe(true)
  for (const line of ['Report line fixed', 'Final checks running', 'Reporting progress', 'Donezo', 'Final', 'Report', 'Final :PASS', 'Final - ready', 'Final check: PASS']) expect(HAND_IN.test(line)).toBe(false)
})

test('a quiet transcript is not running, a max_tokens stop is an ended turn', async ($, on) => {
  const age = { ms: 1000 }
  const { files, clock } = engine(on, { appData: true, transcriptAge: age })
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Linked sessions now:\n- Tester · local_00000000-0000-4000-8000-0000000000b1 · working', wait: false, origin: { kind: 'sdk' } } as never)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Check' }, { do: 'agent', name: 'Tester', status: 'working', task: 'Checking' }] } as never)
  const root = 'C:/Users/someone/AppData/Roaming/Claude/claude-code-sessions/acct/org'
  files.set(`${root}/local_00000000-0000-4000-8000-0000000000b1.json`, JSON.stringify({ sessionId: 'local_00000000-0000-4000-8000-0000000000b1', cliSessionId: 'q-uuid', cwd: '/work/q', title: 'Tester' }))
  const path = 'C:/Users/someone/.claude/projects/-work-q/q-uuid.jsonl'
  const entry = (stop: string, ms: number) => `${JSON.stringify({ type: 'assistant', timestamp: new Date(clock.now() + ms).toISOString(), message: { id: `m${ms}`, stop_reason: stop, content: [{ type: 'tool_use' }] } })}\n`
  // A crashed session: its last line a tool call, then nothing. While fresh it is working.
  files.set(path, entry('tool_use', 100))
  await clock.advance(5000)
  expect(agentOf(files, 'Tester')?.status).toBe('working')
  // Ten minutes with no change: not running, and the card says so (the fake's change time stands still).
  age.ms = 11 * 60_000
  files.set(path, `${entry('tool_use', 100)} `)
  await clock.advance(11_000)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'idle' })
  expect(agentOf(files, 'Tester')?.currentTask).toMatch(/^Not running: last seen \d\d:\d\d$/)
  // It comes back, then stops on max_tokens: that is an ended turn, so in review.
  age.ms = 1000
  files.set(path, `${files.get(path)}${entry('tool_use', 12_000)}`)
  await clock.advance(1100)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'working', currentTask: 'Back at work' })
  files.set(path, `${files.get(path)}${entry('max_tokens', 13_500)}`)
  await clock.advance(1100)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'in_review', currentTask: 'Handed in' })
})

test('one orchestrator rule: lists from the agents; its own planning holds until an agent changes', async ($, on) => {
  const { files, clock } = engine(on)
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const orchestrator = () => JSON.parse(files.get(STATE) ?? 'null').orchestrator
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'T' }, { do: 'agent', name: 'Explorer', status: 'working', task: 'x' }, { do: 'orch', status: 'waiting', waitingOn: ['Worker'] }] } as never)
  // What it waits on is who works, whatever it wrote; WAITING once its own turn has ended.
  await $.classic.Stop({ stop_hook_active: false } as never)
  expect(orchestrator()).toMatchObject({ status: 'waiting', waitingOn: ['Explorer'], reviewing: [] })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'orch', status: 'needs_user' }] } as never)
  expect(orchestrator()).toMatchObject({ status: 'needs_user', waitingOn: ['Explorer'] })
  // An agent's state changes (later): its own status gives way to what the agents show.
  await clock.advance(1000)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'agent', name: 'Explorer', status: 'in_review', task: 'Reported' }] } as never)
  expect(orchestrator()).toMatchObject({ status: 'reviewing', reviewing: ['Explorer'], waitingOn: [] })
})

test('a helper running again after its hand-in shows working with its next brief; accept and the turn-end guard leave it so', async ($, on) => {
  const { files, clock } = engine(on, { appData: true })
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Linked sessions now:\n- Worker · local_00000000-0000-4000-8000-0000000000b2 · working', wait: false, origin: { kind: 'sdk' } } as never)
  const root = 'C:/Users/someone/AppData/Roaming/Claude/claude-code-sessions/acct/org'
  files.set(`${root}/local_00000000-0000-4000-8000-0000000000b2.json`, JSON.stringify({ sessionId: 'local_00000000-0000-4000-8000-0000000000b2', cliSessionId: 'w-uuid', cwd: '/work/w2', title: 'Worker' }))
  const path = 'C:/Users/someone/.claude/projects/-work-w2/w-uuid.jsonl'
  const entry = (type: string, ms: number, stop?: string) => `${JSON.stringify({ type, timestamp: new Date(clock.now() + ms).toISOString(), message: { id: `m${ms}`, ...(stop ? { stop_reason: stop } : {}), content: type === 'user' ? 'brief' : [{ type: 'text', text: 'x' }] } })}\n`
  // Its first job, and a second brief queued while it works.
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Fix' }, { do: 'agent', name: 'Worker', status: 'working', task: 'Fix the lows' }, { do: 'event', type: 'dispatch', from: 'orchestrator', to: 'worker', text: 'Fix the lows' }] } as never)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'event', type: 'dispatch', from: 'orchestrator', to: 'worker', text: 'Then the five recheck items' }] } as never)
  files.set(path, entry('user', 10) + entry('assistant', 20, 'tool_use'))
  // The helper's record is read every 4 seconds; from then on its transcript is followed every second.
  await clock.advance(4100)
  expect(agentOf(files, 'Worker')?.status).toBe('working')
  // It hands in, and its turn ends: in review, with its own line.
  await $.tool.call({ tool: TOOL, as: 'worker', updates: [{ do: 'say', type: 'report', text: 'Done: the lows are fixed' }] } as never)
  files.set(path, `${files.get(path)}${entry('assistant', 200, 'end_turn')}`)
  await clock.advance(1100)
  expect(agentOf(files, 'Worker')).toMatchObject({ status: 'in_review', currentTask: 'Done: the lows are fixed' })
  // The queued brief starts it again: working within a second, with that brief as its task.
  const began = clock.now() + 50
  files.set(path, `${files.get(path)}${entry('user', 50)}`)
  await clock.advance(1100)
  expect(agentOf(files, 'Worker')).toMatchObject({ status: 'working', currentTask: 'Then the five recheck items', startedAt: began })
  // The turn-end guard does not name it: it is not waiting on the orchestrator.
  await $.tool.call({ tool: TOOL, updates: [{ do: 'agent', name: 'Worker', status: 'in_review', task: 'Reported: the lows' }] } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Worker')?.status).toBe('working')
  const answer = (await $.classic.Stop({ stop_hook_active: false } as never)) as { block?: string }
  expect(answer.block ?? '').not.toContain('Worker')
  // Accepting the first job while it runs: the acceptance is logged, the card stays working.
  await $.tool.call({ tool: TOOL, updates: [{ do: 'accept', name: 'Worker' }] } as never)
  await clock.advance(10)
  expect(logOf(files).some(line => line.startsWith('agent_done worker>orchestrator'))).toBe(true)
  expect(agentOf(files, 'Worker')?.status).toBe('working')
})

test('liveness: any write is a sign of life; the orchestrator plugin keeps a running task live by itself', async ($, on) => {
  const now = Date.UTC(2026, 0, 1, 9)
  const state = (status: 'running' | 'paused', lastUpdated: number) =>
    ({ task: { id: 't', title: 'T', status, startedAt: 0 }, plan: null, queue: [], agents: [], orchestrator: { status: 'idle', waitingOn: [], reviewing: [] }, lastUpdated }) as unknown as McState
  // Nothing written to the state for two minutes, but a helper's line in the log a second ago: live.
  expect(isOffline(state('running', now - 120_000), now, now - 1000)).toBe(false)
  // No sign of life from anything for over a minute: offline. A paused task never is.
  expect(isOffline(state('running', now - 120_000), now, now - OFFLINE_MS - 1)).toBe(true)
  expect(isOffline(state('paused', now - 600_000), now, 0)).toBe(false)

  // With no other process, the orchestrator's plugin marks a running task fresh from its own clock.
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'T' }] } as never)
  const first = JSON.parse(files.get(STATE) ?? 'null').lastUpdated as number
  await clock.advance(5 * 60_000)
  const last = JSON.parse(files.get(STATE) ?? 'null').lastUpdated as number
  expect(clock.now() - last).toBeLessThan(OFFLINE_MS)
  expect(last).toBeGreaterThan(first)
})

test('stop reasons: a tool call or a server pause goes on; every other stop ends the turn', () => {
  const last = (stop: string | null) => `${JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T09:00:00Z', message: { id: 'm', stop_reason: stop, content: [] } })}\n`
  for (const stop of ['tool_use', 'pause_turn', null]) expect(turnOf(last(stop)).state).toBe('running')
  for (const stop of ['end_turn', 'max_tokens', 'stop_sequence', 'refusal']) expect(turnOf(last(stop)).state).toBe('ended')
})

/** A transcript line, with made-up ids and words. */
const said = (type: 'user' | 'assistant', at: number, content: unknown, stop?: string) =>
  `${JSON.stringify({ type, timestamp: new Date(at).toISOString(), message: { id: `m${at}`, ...(stop ? { stop_reason: stop } : {}), content } })}\n`

/** An engine with one helper (Tester) whose transcript the test writes; returns that transcript's path. */
async function withHelper($: Engine, on: On, role = 'Tester') {
  const made = engine(on, { appData: true })
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const id = 'local_00000000-0000-4000-8000-0000000000c1'
  await $.prompt.submit({ text: `Linked sessions now:\n- ${role} · ${id} · working`, wait: false, origin: { kind: 'sdk' } } as never)
  made.files.set(`C:/Users/someone/AppData/Roaming/Claude/claude-code-sessions/acct/org/${id}.json`, JSON.stringify({ sessionId: id, cliSessionId: 'h-uuid', cwd: '/work/h', title: role }))
  return { ...made, path: 'C:/Users/someone/.claude/projects/-work-h/h-uuid.jsonl' }
}

test("a helper's end-of-turn question is NEEDS YOU, with only the question; the person's answer makes it working", async ($, on) => {
  const { files, clock, path } = await withHelper($, on)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Recheck' }, { do: 'agent', name: 'Tester', status: 'working', task: 'Rechecking' }] } as never)
  const t = clock.now()
  // The real case, reduced: work, a next-step question (wrap_up with ask), its result, a final answer.
  files.set(
    path,
    said('user', t + 10, 'Recheck the package') +
      said('assistant', t + 20, [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'true' } }], 'tool_use') +
      said('user', t + 30, [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }]),
  )
  await clock.advance(4100)
  expect(agentOf(files, 'Tester')?.status).toBe('working')
  const u = clock.now()
  files.set(
    path,
    `${files.get(path)}${said('assistant', u + 10, [{ type: 'tool_use', id: 'u2', name: 'mcp__ccd_turn__wrap_up', input: { recap: 'Three fixes needed. A secret recap.', ask: 'Should I run the interactive type-check step in a scratch copy?', actions: [{ label: 'Not now' }] } }], 'tool_use')}${said('user', u + 20, [{ type: 'tool_result', tool_use_id: 'u2', content: 'Shown in the next-step box.' }])}${said('assistant', u + 30, [{ type: 'text', text: 'Verdict: FAIL. Private details follow?' }], 'end_turn')}`,
  )
  await clock.advance(1100)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'needs_user', currentTask: 'Should I run the interactive type-check step in a scratch copy?' })
  expect(logOf(files)).toContain('needs_user tester>orchestrator: Should I run the interactive type-check step in a scratch copy?')
  // Only the question: nothing else from the turn reaches the log.
  expect(logOf(files).join(' ')).not.toMatch(/secret recap|Private details|Verdict/)
  // Counted in the legend.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const graph = (await ui.findAll({ type: 'Svg' })).find(found => String(found.props.alt).startsWith('Agents.'))
  expect(String(graph?.props.source)).toContain('>1 NEEDS YOU<')
  await ui.unmount()
  // The turn-end guard does not name it: it waits on the person, not on the orchestrator.
  const answer = (await $.classic.Stop({ stop_hook_active: false } as never)) as { block?: string }
  expect(answer.block ?? '').not.toContain('Tester')
  // The person answers ("Not now"): its session runs again, and the card is working by itself.
  files.set(path, `${files.get(path)}${said('user', clock.now() + 500, 'Not now')}`)
  await clock.advance(1100)
  expect(agentOf(files, 'Tester')?.status).toBe('working')
})

test('a question tool waiting for its answer is NEEDS YOU; its answer makes it working; a final "?" alone is not a question', async ($, on) => {
  const { files, clock, path } = await withHelper($, on)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Fix' }, { do: 'agent', name: 'Tester', status: 'working', task: 'Fixing' }] } as never)
  const t = clock.now()
  files.set(path, said('user', t + 10, 'Fix it') + said('assistant', t + 20, [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which option should the fix use?', header: 'Option', options: [] }] } }], 'tool_use'))
  await clock.advance(4100)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'needs_user', currentTask: 'Which option should the fix use?' })
  // Still waiting 11 minutes later: still NEEDS YOU, not "Not running".
  await clock.advance(11 * 60_000)
  expect(agentOf(files, 'Tester')?.status).toBe('needs_user')
  files.set(path, `${files.get(path)}${said('user', clock.now() + 10, [{ type: 'tool_result', tool_use_id: 'q1', content: 'The first' }])}`)
  await clock.advance(1100)
  expect(agentOf(files, 'Tester')?.status).toBe('working')
  // A final message that merely ends with a question mark: in review, not NEEDS YOU.
  files.set(path, `${files.get(path)}${said('assistant', clock.now() + 10, [{ type: 'text', text: 'Fixed. Anything else?' }], 'end_turn')}`)
  await clock.advance(1100)
  expect(agentOf(files, 'Tester')?.status).toBe('in_review')
})

test('done is per task: a task ending idles every agent; a state of another task shows idle; events carry the task', async ($, on) => {
  const { files } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'One' }, { do: 'agent', name: 'Explorer', status: 'done', task: 'Found it' }, { do: 'event', type: 'agent_done', from: 'explorer', to: 'orchestrator', text: 'Found it' }] } as never)
  const one = JSON.parse(files.get(STATE) ?? 'null').task.id as string
  expect(JSON.parse(files.get(STATE) ?? 'null').agents[0]).toMatchObject({ status: 'done', taskId: one })
  expect(JSON.parse((files.get(EVENTS) ?? '').trim().split('\n').at(-1) ?? '{}')).toMatchObject({ type: 'agent_done', taskId: one })
  // The task ends: every agent idle, no words, no task.
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.done' }] } as never)
  const agent = JSON.parse(files.get(STATE) ?? 'null').agents[0]
  expect(agent).toMatchObject({ status: 'idle', currentTask: '' })
  expect(agent.taskId).toBeUndefined()
  // A state written under another task reads as idle here; an old one without a task id counts as this task's.
  const state = JSON.parse(files.get(STATE) ?? 'null')
  state.task = { id: 'two', title: 'Two', status: 'running', startedAt: 1 }
  state.agents = [
    { id: 'explorer', name: 'Explorer', status: 'done', currentTask: 'Work for task one', startedAt: 1, taskId: one },
    { id: 'worker', name: 'Worker', status: 'working', currentTask: 'Old file, no task id', startedAt: 1 },
  ]
  files.set(STATE, JSON.stringify(state))
  await $.tool.call({ tool: TOOL, updates: [{ do: 'heartbeat' }] } as never)
  expect(agentOf(files, 'Explorer')).toMatchObject({ status: 'idle', currentTask: '' })
  expect(agentOf(files, 'Worker')).toMatchObject({ status: 'working', currentTask: 'Old file, no task id' })
  // Work for something else, said so: logged with its mark, and the Activity view shows it.
  await $.tool.call({ tool: TOOL, updates: [{ do: 'event', type: 'dispatch', from: 'orchestrator', to: 'explorer', text: 'Look at the other repo', side: true }] } as never)
  expect(JSON.parse((files.get(EVENTS) ?? '').trim().split('\n').at(-1) ?? '{}')).toMatchObject({ side: true, taskId: 'two' })
  expect(agentOf(files, 'Explorer')?.status).toBe('idle')
})

test('work for another task: running shows "Other task:", its end leaves the card idle and logs the mark', async ($, on) => {
  const { files, clock, path } = await withHelper($, on, 'Explorer')
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Main' }, { do: 'event', type: 'dispatch', from: 'orchestrator', to: 'explorer', text: 'Look at the other repo', side: true }] } as never)
  const t = clock.now()
  files.set(path, said('user', t + 10, 'Look at the other repo') + said('assistant', t + 20, [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }], 'tool_use'))
  await clock.advance(4100)
  expect(agentOf(files, 'Explorer')).toMatchObject({ status: 'working', currentTask: 'Other task: Look at the other repo' })
  files.set(path, `${files.get(path)}${said('user', clock.now() + 10, [{ type: 'tool_result', tool_use_id: 'x', content: '' }])}${said('assistant', clock.now() + 20, [{ type: 'text', text: 'Done.' }], 'end_turn')}`)
  await clock.advance(1100)
  expect(agentOf(files, 'Explorer')?.status).toBe('idle')
  const last = JSON.parse((files.get(EVENTS) ?? '').trim().split('\n').at(-1) ?? '{}')
  expect(last).toMatchObject({ type: 'report', from: 'explorer', side: true })
})

/** The demo states as data (as `mc.py demo` writes them), for the terminal's text pane. */
function demoData(name: string, now: number): MissionData {
  const m = 60_000
  const agent = (n: string, status: McAgent['status'], task: string, started: number): McAgent => ({ id: n.toLowerCase(), name: n, status, currentTask: task, startedAt: started })
  const six = ['Find', 'Fix', 'Review', 'Verify', 'PR dev', 'Wrap up']
  const plan = (statuses: string[]) => statuses.map((status, i) => ({ id: `s${i + 1}`, label: six[i] ?? '', status: status as 'done' }))
  const task = { id: 't1', title: 'Full app: the header grows on the way back in the production build', status: 'running' as const, startedAt: now - 14 * m }
  const ev = (at: number, type: string, from: string, text: string): McEvent => ({ time: at, type: type as 'dispatch', from, to: 'orchestrator', text })
  const state: McState = {
    task,
    plan: plan(['done', 'done', 'done', 'active', 'pending', 'pending']),
    queue: [{ id: 'q1', text: 'Also check the same header on Android', receivedAt: now - 6 * m }],
    agents: [agent('Explorer', 'done', 'Only one place reads a time this way', now - 5 * m), agent('Worker', 'done', 'Fix pushed', now - 3 * m), agent('Tester', 'working', 'Verifying the fix on a production build', now - 8 * m), agent('Security', 'working', 'Reviewing the fix for the CSP', now - 2 * m)],
    orchestrator: { status: 'waiting', waitingOn: ['Tester', 'Security'], reviewing: [] },
    lastUpdated: now,
  }
  let events: McEvent[] = [ev(now - 14 * m, 'dispatch', 'orchestrator', 'Find the story code'), ev(now - 9 * m, 'progress', 'tester', 'Built the app; 20 screens to compare'), ev(now - 20_000, 'dispatch', 'orchestrator', 'Verifying and reviewing the fix')]
  let aliveAt = now
  switch (name) {
    case 'idle':
      state.task = null
      state.plan = null
      state.queue = []
      state.agents = state.agents.map(a => agent(a.name, 'idle', '', now))
      events = []
      break
    case 'running-noplan':
      state.plan = null
      break
    case 'skipped':
      state.plan = plan(['done', 'done', 'done', 'done', 'skipped', 'active'])
      break
    case 'needs-user':
      state.agents[1] = agent('Worker', 'needs_user', 'Should the fix also cover the Activity view header?', now - m)
      break
    case 'in-review':
      state.agents[2] = agent('Tester', 'in_review', 'Reported: 6 checks failed, 2 in lint', now - 3 * m)
      break
    case 'queue-3':
      state.queue = [...state.queue, { id: 'q2', text: 'Then update the changelog', receivedAt: now }, { id: 'q3', text: 'Look at the dock shadow in Safari', receivedAt: now }]
      break
    case 'paused':
      state.task = { ...task, status: 'paused', pausedAt: now - 10_000, pauseReason: 'Waiting for the owner' }
      break
    case 'offline':
      state.lastUpdated = now - 5 * m
      aliveAt = now - 5 * m
      break
    case 'done':
      state.task = { ...task, status: 'done', finishedAt: now - 30_000 }
      state.plan = plan(['done', 'done', 'done', 'done', 'done', 'done'])
      state.agents = state.agents.map(a => agent(a.name, 'idle', '', now))
      break
    case 'failed':
      state.task = { ...task, status: 'failed', finishedAt: now - 20_000 }
      state.agents = state.agents.map(a => agent(a.name, 'idle', '', now))
      events.push(ev(now - 20_000, 'task_failed', 'tester', 'The build fails before the tests run'))
      break
    case 'all-states':
      state.agents = [
        agent('Explorer', 'done', 'Only one place reads a time this way', now - 5 * m),
        agent('Worker', 'working', 'Changing the story to read either unit', now - 3 * m),
        agent('Tester', 'in_review', 'Reported: 6 checks failed, 2 in lint', now - 40_000),
        agent('Security', 'needs_user', 'Should the CSP allow the new font host?', now - m),
        agent('Reviewer', 'working', 'Reviewing the copy of the new header', now - 90_000),
        agent('Writer', 'queued', 'Waits for the fix to write the notes', now),
        agent('Scout', 'idle', '', now),
      ]
      break
  }
  return { loaded: true, state, events, eventCount: events.length, fresh: [], readAt: now, offline: false, aliveAt }
}

const DEMOS = ['idle', 'running-plan', 'running-noplan', 'skipped', 'needs-user', 'in-review', 'queue-3', 'paused', 'offline', 'done', 'failed', 'all-states']
const PILL_OF: Record<string, string> = { idle: 'IDLE', paused: 'PAUSED', offline: 'OFFLINE', done: 'IDLE', failed: 'IDLE' }
const WORD_OF: Record<string, string> = { working: 'WORKING', done: 'DONE', needs_user: 'NEEDS YOU', in_review: 'IN REVIEW', queued: 'QUEUED', idle: 'IDLE' }

test('the terminal text pane: every demo state at 80, 60 and 40 columns fits, and says every state in words', () => {
  const now = Date.UTC(2026, 0, 1, 9)
  for (const name of DEMOS) {
    const data = demoData(name, now)
    for (const columns of [80, 60, 40]) {
      for (const ascii of [false, true]) {
        const lines = overviewLines(data, now, { columns, rows: 60, ascii }).map(plainOf)
        const where = `${name} at ${columns}${ascii ? ' (ascii)' : ''}`
        for (const line of [...lines, ...activityLines(data, { columns, rows: 60, ascii }).map(plainOf)]) {
          if (cellsOf(line) > columns) throw new Error(`${where}: a line of ${cellsOf(line)} cells: ${line}`)
        }
        const text = lines.join('\n')
        expect(lines[0]).toContain(PILL_OF[name] ?? 'LIVE')
        for (const agent of data.state?.agents ?? []) {
          const word = data.state?.task ? (WORD_OF[agent.status] ?? '') : 'IDLE'
          if (!text.includes(word)) throw new Error(`${where}: no ${word} for ${agent.name}`)
        }
        if (ascii && /[■▣□▸✓◌↺✕…·]/.test(text)) throw new Error(`${where}: a glyph in ASCII mode`)
      }
    }
  }
  // The rows the design names.
  const plain = (name: string, columns = 80) => overviewLines(demoData(name, now), now, { columns, rows: 60, ascii: false }).map(plainOf).join('\n')
  expect(plain('running-plan')).toContain('■■■▣□□')
  expect(plain('running-plan')).toContain('VERIFY 4 of 6 · next PR dev')
  expect(plain('skipped')).toContain('■■■■·▣')
  expect(plain('running-noplan')).toMatch(/working 14:00/)
  expect(plain('paused')).toContain('PAUSED AT VERIFY')
  expect(plain('done')).toContain('DONE 6 of 6 · 14 MIN')
  expect(plain('failed')).toContain('FAILED 4 of 6 · The build fails before the tests run')
  expect(plain('offline')).toContain('No update since')
  expect(plain('queue-3')).toContain('+1 more')
  expect(plain('in-review')).toMatch(/IN REVIEW 3 min/)
  expect(plain('all-states', 40)).toMatch(/2 ACTIVE · 1 IN REVIEW · 1 NEEDS YOU/)
  // A short pane: one line per agent's task instead of two.
  const short = overviewLines(demoData('all-states', now), now, { columns: 40, rows: 10, ascii: false })
  expect(short.length).toBeLessThan(overviewLines(demoData('all-states', now), now, { columns: 40, rows: 99, ascii: false }).length)
})

test('the terminal pane: Activity opens with a, Back with b; /mission ascii switches the glyphs', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Try the text pane' }, { do: 'plan.set', steps: ['Find', 'Fix', 'Verify'] }, { do: 'agent', name: 'Tester', status: 'working', task: 'Checking' }] } as never)
  await clock.advance(1000)
  const term = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 60 } })
  expect(await term.find({ type: 'Text', text: /▣□□/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: 'WORKING' })).toBeDefined()
  const activityButton = await term.find({ type: 'Button', key: 'activity' })
  expect(activityButton?.props.hotkey).toBe('a')
  await term.press({ key: 'activity' })
  expect(await term.find({ type: 'Text', text: 'Activity' })).toBeDefined()
  const back = await term.find({ type: 'Button', key: 'back' })
  expect(back?.props.hotkey).toBe('b')
  await term.press({ key: 'back' })
  expect(await term.find({ type: 'Text', text: 'Mission Control' })).toBeDefined()
  await $.command.run({ command: 'mission', args: 'ascii on', origin: { kind: 'person' }, presentation: { isFullscreen: false } } as never)
  expect(await term.find({ type: 'Text', text: /\[>--\]/ })).toBeDefined()
  await term.unmount()
})

/** A helper session (the Explorer) that knows its role, with the orchestrator's state as it finds it. */
async function helperSession($: Engine, on: On) {
  const made = engine(on)
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.PermissionRequest', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  made.files.set(STATE, JSON.stringify({ task: { id: 't', title: 'Audit', status: 'running', startedAt: 1 }, plan: null, queue: [], agents: [{ id: 'explorer', name: 'Explorer', status: 'working', currentTask: 'Auditing', startedAt: 1 }], orchestrator: { status: 'waiting', waitingOn: [], reviewing: [] }, lastUpdated: made.clock.now() }))
  await $.prompt.submit({ text: 'Audit it. Report progress with: mc.py say --as explorer "..."', wait: false, origin: { kind: 'peer' } } as never)
  await made.clock.advance(10)
  return made
}

test("a helper's own permission prompt clears on allow, on deny, and when its turn ends", async ($, on) => {
  const { files, clock } = await helperSession($, on)
  const ask = async () => {
    await $.classic.PermissionRequest({ tool_name: 'mcp__Claude_Browser__preview_start', tool_input: { url: 'file:///x/helper-question.html' } } as never)
    await clock.advance(10)
    expect(agentOf(files, 'Explorer')).toMatchObject({ status: 'needs_user', currentTask: 'Allow or deny: preview_start helper-question.html' })
  }
  await ask()
  await $.classic.PostToolUse({ tool_name: 'mcp__Claude_Browser__preview_start', tool_input: {}, tool_response: 'opened' } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Explorer')).toMatchObject({ status: 'working', currentTask: 'Auditing' })
  await ask()
  await $.classic.PermissionDenied({ tool_name: 'mcp__Claude_Browser__preview_start', tool_input: {}, reason: 'denied' } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Explorer')?.status).toBe('working')
  await ask()
  await $.classic.Stop({ stop_hook_active: false } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Explorer')?.status).toBe('working')
})

test('with no plugin in the helper: a stalled call is a guessed NEEDS YOU after 10 seconds; shell commands never are', async ($, on) => {
  const { files, clock, path } = await withHelper($, on)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Preview' }, { do: 'agent', name: 'Tester', status: 'working', task: 'Checking the previews' }] } as never)
  // The real shape: a preview_start call, then nothing (a prompt waits on the person).
  const t = clock.now()
  files.set(path, said('user', t, 'Look at the preview') + said('assistant', t + 100, [{ type: 'tool_use', id: 'p1', name: 'mcp__Claude_Browser__preview_start', input: { url: 'file:///x/helper-question.html' } }], 'tool_use'))
  await clock.advance(5_000)
  expect(agentOf(files, 'Tester')?.status).toBe('working')
  // Shown within a second of the 10-second mark (the watcher looks every second while a call waits).
  await clock.advance(6_000)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'needs_user', currentTask: 'May be waiting for your permission: preview_start' })
  expect(logOf(files)).toContain('needs_user tester>orchestrator: May be waiting for your permission: preview_start')
  // Its result arrives: working again by itself.
  files.set(path, `${files.get(path)}${said('user', clock.now() + 10, [{ type: 'tool_result', tool_use_id: 'p1', content: 'opened' }])}`)
  await clock.advance(1100)
  expect(agentOf(files, 'Tester')?.status).toBe('working')
  // A shell command two minutes long: still working.
  const b = clock.now()
  files.set(path, `${files.get(path)}${said('assistant', b, [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm run build' } }], 'tool_use')}`)
  await clock.advance(120_000)
  expect(agentOf(files, 'Tester')?.status).toBe('working')
  // A finished turn is never a guessed prompt.
  files.set(path, `${files.get(path)}${said('user', clock.now(), [{ type: 'tool_result', tool_use_id: 'b1', content: 'built' }])}${said('assistant', clock.now() + 10, [{ type: 'text', text: 'Built.' }], 'end_turn')}`)
  await clock.advance(40_000)
  expect(agentOf(files, 'Tester')?.status).toBe('in_review')
})

test("the guess never covers the helper's own NEEDS YOU (its plugin's exact words stay)", async ($, on) => {
  const { files, clock, path } = await withHelper($, on)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Preview' }, { do: 'agent', name: 'Tester', status: 'working', task: 'Checking' }] } as never)
  const t = clock.now()
  files.set(path, said('user', t, 'Look') + said('assistant', t + 100, [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/x/a.md' } }], 'tool_use'))
  await clock.advance(4100)
  // The helper's own plugin set it, with the exact prompt.
  await $.tool.call({ tool: TOOL, updates: [{ do: 'agent', name: 'Tester', status: 'needs_user', task: 'Allow or deny: Write a.md' }] } as never)
  await clock.advance(40_000)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'needs_user', currentTask: 'Allow or deny: Write a.md' })
  expect(logOf(files).some(line => line.includes('May be waiting'))).toBe(false)
})

test('control characters never reach the files: an escape sequence in a title is dropped, whitespace still folds', async ($, on) => {
  const { files } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Fix\u001b[31m the\theader\u009b2J\nnow\u0007' }] } as never)
  expect(JSON.parse(files.get(STATE) ?? 'null').task.title).toBe('Fix[31m the header2J now')
})

const PANEL = 'C:/Users/someone/.claude/mission-control/.panel.json'

test('the measured cell: an earlier measurement is used at once, with no measuring drawing', async ($, on) => {
  const { files, clock } = engine(on, { unmeasured: true })
  files.set(PANEL, JSON.stringify({ cell: 22, measuredAt: 1 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Svg' })).map(found => String(found.props.alt))).not.toContain('Loading the team')
  await ui.unmount()
})

test('the panel is always drawn: at once with no measurement, and a resize redraws it at the new scale (never blank)', async ($, on) => {
  const { files, clock } = engine(on, { unmeasured: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)
  const widthOf = async (ui: { findAll: (q: { type: 'Svg' }) => Promise<readonly { props: Record<string, unknown> }[]> }) =>
    Number((await ui.findAll({ type: 'Svg' })).find(found => String(found.props.alt).startsWith('Agents.'))?.props.width)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 30 } })
  const alts = (await ui.findAll({ type: 'Svg' })).map(found => String(found.props.alt))
  expect(alts).not.toContain('Loading the team')
  // The default cell (26.7): 30 columns x 26.7 x 0.4 = 320.4 of the design's 400.
  expect(Math.abs((await widthOf(ui)) - 320.4)).toBeLessThan(0.05)
  // Resized: the very next draw is the panel at the new scale.
  await ui.redraw({ ...PANE.props, bodyColumns: 20 })
  expect((await ui.findAll({ type: 'Svg' })).map(found => String(found.props.alt))).not.toContain('Loading the team')
  expect(Math.abs((await widthOf(ui)) - 213.6)).toBeLessThan(0.05)
  await ui.unmount()
  // Nothing measured, nothing stored.
  await clock.advance(30_000)
  expect(files.has(PANEL)).toBe(false)
})

test('/mission measure measures (its drawing only while asked) and keeps the result', async ($, on) => {
  const { files, clock } = engine(on, { unmeasured: true })
  on('ui.scroll', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // A scroll that is not a measurement changes nothing.
  await $.ui.scroll({ in: PANE.requestId, requestId: PANE.requestId, contentRows: 200, to: 'end' } as never)
  expect(files.has(PANEL)).toBe(false)
  await $.command.run({ command: 'mission', args: 'measure', origin: { kind: 'person' }, presentation: { isFullscreen: false } } as never)
  // The measuring drawing (4000px) took 200 rows: a 20px line.
  await $.ui.scroll({ in: PANE.requestId, requestId: PANE.requestId, contentRows: 200, to: 'end' } as never)
  await clock.advance(10)
  expect(JSON.parse(files.get(PANEL) ?? '{}')).toMatchObject({ cell: 19.99, source: 'measured' })
})

test('/mission debug on writes the pane numbers on every change of columns or rows', async ($, on) => {
  const { files, clock } = engine(on, { unmeasured: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'mission', args: 'debug on', origin: { kind: 'person' }, presentation: { isFullscreen: false } } as never)
  await clock.advance(1000)
  const debugOf = () => JSON.parse(files.get('C:/Users/someone/.claude/mission-control/.panel-debug.json') ?? '{}').panel
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 43, scroll: { offset: 0, bodyRows: 39 } } })
  await clock.advance(10)
  expect(debugOf()).toMatchObject({ bodyColumns: 43, bodyRows: 39, columnPx: 10.68, rowPx: 20.3, rowSource: 'default', scale: 1, budget: 779 })
  // Only the rows change: written again.
  await ui.redraw({ ...PANE.props, bodyColumns: 43, scroll: { offset: 0, bodyRows: 30 } })
  await clock.advance(10)
  expect(debugOf()).toMatchObject({ bodyRows: 30, budget: 597 })
  await ui.unmount()
})

test('the Overview fits the pane: at 30, 39 and 50 rows its height is at most rows x 20.3px, with all four agent cards', async ($, on) => {
  const { clock } = engine(on, { unmeasured: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Fit the pane' }, { do: 'plan.set', steps: ['Find', 'Fix', 'Verify'] }, { do: 'agent', name: 'Tester', status: 'working', task: 'Checking' }] } as never)
  await clock.advance(1000)
  for (const bodyRows of [30, 39, 50]) {
    const props = { ...PANE.props, bodyColumns: 43, scroll: { offset: 0, bodyRows } }
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props })
    // The drawings a change replaced lie over the new ones for 400ms (swap.ts): let them lift first.
    await clock.advance(1000)
    await ui.redraw(props)
    const svgs = await ui.findAll({ type: 'Svg' })
    // The column's height: every drawing in it, the update row once (its three pieces sit side by side).
    const height = svgs
      .filter(found => !['Open the activity', 'End of the latest update'].includes(String(found.props.alt)))
      .reduce((sum, found) => sum + Number(found.props.height), 0)
    expect(height).toBeLessThan(bodyRows * 20.3 + 0.5)
    const agents = svgs.find(found => String(found.props.alt).startsWith('Agents.'))
    for (const name of ['Explorer', 'Worker', 'Tester', 'Security']) expect(String(agents?.props.alt)).toContain(`${name}:`)
    await ui.unmount()
  }
})

test('a slash command typed in a helper session is not a running turn, and revives no old brief', async ($, on) => {
  const { files, clock, path } = await withHelper($, on, 'Security')
  // A brief from an earlier task, then a new task in which Security has no part yet.
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Earlier' }, { do: 'event', type: 'dispatch', from: 'orchestrator', to: 'security', text: 'Security: final scan before publishing' }] } as never)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.done' }, { do: 'task.start', title: 'Now' }] } as never)
  const t = clock.now()
  // The exact tail: its last turn ended; then the person typed /mission there.
  files.set(
    path,
    said('user', t - 60_000, 'Security: final scan before publishing') +
      said('assistant', t - 30_000, [{ type: 'text', text: 'Scan done.' }], 'end_turn') +
      `${JSON.stringify({ type: 'queue-operation', timestamp: new Date(t).toISOString() })}\n` +
      `${JSON.stringify({ type: 'user', timestamp: new Date(t + 40).toISOString(), message: { role: 'user', content: '<command-name>/mission</command-name>\n<command-message>mission</command-message>\n<command-args></command-args>' } })}\n` +
      `${JSON.stringify({ type: 'system', subtype: 'local_command', timestamp: new Date(t + 40).toISOString(), content: '<local-command-stdout>Mission Control opened.</local-command-stdout>' })}\n`,
  )
  await clock.advance(5000)
  // Never shown working (before the fix: working, "Other task: Security: final scan before publishing").
  expect(agentOf(files, 'Security')?.status ?? 'idle').toBe('idle')
  expect(agentOf(files, 'Security')?.currentTask ?? '').not.toContain('Other task')
  expect(turnOf(files.get(path) ?? '').state).toBe('ended')
})

const ROLES = 'C:/Users/someone/.claude/mission-control/.roles.json'
/** A helper session that has had no brief: only the state, as it finds it. */
async function quietHelper($: Engine, on: On, call: () => Promise<{ result: string }> = async () => ({ result: 'ok' })) {
  const made = engine(on)
  on('tool.call', call)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.PermissionRequest', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  made.files.set(STATE, JSON.stringify({ task: { id: 't', title: 'Check', status: 'running', startedAt: 1 }, plan: null, queue: [], agents: [{ id: 'tester', name: 'Tester', status: 'working', currentTask: 'Checking the previews', startedAt: 1 }], orchestrator: { status: 'waiting', waitingOn: [], reviewing: [] }, lastUpdated: made.clock.now() }))
  return made
}

test("a helper knows its own role from the orchestrator's record of its session, with no brief", async ($, on) => {
  const { files, clock } = await quietHelper($, on)
  // The orchestrator's watcher recorded this session's transcript (session.id) as the Tester's.
  files.set(ROLES, JSON.stringify({ 'cli-orch': 'Tester' }))
  await $.classic.PermissionRequest({ tool_name: 'Write', tool_input: { file_path: '/x/notes.md' } } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'needs_user', currentTask: 'Allow or deny: Write notes.md' })
})

test('a wrapped cross-session brief names the role, and the role is kept for the session', async ($, on) => {
  const { files, clock } = await quietHelper($, on)
  const brief = 'Another Claude session sent a message:\n<cross-session-message from="local_00000000-0000-4000-8000-0000000000aa" from-name="Master Orchestrator">\nCheck it. Progress: python3 mc.py say --as tester "..."\n</cross-session-message>'
  await $.prompt.submit({ text: brief, wait: false, origin: { kind: 'peer' } } as never)
  await clock.advance(10)
  expect(JSON.parse(files.get(ROLES) ?? '{}')).toMatchObject({ 'cli-orch': 'Tester' })
  await $.classic.PermissionRequest({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com/x' } } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'needs_user', currentTask: 'Allow or deny: WebFetch example.com' })
})

test("a helper's own call still open after 1 second shows NEEDS YOU; the exact prompt replaces it; its return clears it", async ($, on) => {
  const gate: { release?: () => void } = {}
  const { files, clock } = await quietHelper($, on, () => new Promise(resolve => (gate.release = () => resolve({ result: 'opened' }))))
  files.set(ROLES, JSON.stringify({ 'cli-orch': 'Tester' }))
  const call = $.tool.call({ tool: 'mcp__Claude_Browser__preview_start', url: 'file:///x/page.html' } as never)
  await clock.advance(500)
  expect(agentOf(files, 'Tester')?.status).toBe('working')
  await clock.advance(600)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'needs_user', currentTask: 'May be waiting for you: preview_start' })
  // The engine reports the prompt: its exact words replace the timed ones.
  await $.classic.PermissionRequest({ tool_name: 'mcp__Claude_Browser__preview_start', tool_input: { url: 'file:///x/page.html' } } as never)
  await clock.advance(10)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'needs_user', currentTask: 'Allow or deny: preview_start page.html' })
  // Answered: the call returns, and the card is back to what it was.
  gate.release?.()
  await call
  await clock.advance(10)
  expect(agentOf(files, 'Tester')).toMatchObject({ status: 'working', currentTask: 'Checking the previews' })
})

test("a helper's long shell command is never taken for a prompt", async ($, on) => {
  const gate: { release?: () => void } = {}
  const { files, clock } = await quietHelper($, on, () => new Promise(resolve => (gate.release = () => resolve({ result: 'built' }))))
  files.set(ROLES, JSON.stringify({ 'cli-orch': 'Tester' }))
  const call = $.tool.call({ tool: 'Bash', command: 'npm run build' } as never)
  await clock.advance(60_000)
  expect(agentOf(files, 'Tester')?.status).toBe('working')
  gate.release?.()
  await call
})

test('after /mission, and after each of three resizes, the very next draw is the full panel (never blank, never measuring)', async ($, on) => {
  const { clock } = engine(on, { unmeasured: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Look at the pane' }, { do: 'agent', name: 'Tester', status: 'working', task: 'Checking' }] } as never)
  await clock.advance(1000)
  await $.command.run({ command: 'mission', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: false } } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 38 } })
  const full = async () => {
    const alts = (await ui.findAll({ type: 'Svg' })).map(found => String(found.props.alt))
    expect(alts).not.toContain('Loading the team')
    // The whole panel: its header, the task card and the agents.
    expect(alts.some(alt => alt.startsWith('Mission Control'))).toBe(true)
    expect(alts.some(alt => alt.startsWith('Current task: Look at the pane'))).toBe(true)
    expect(alts.some(alt => alt.startsWith('Agents.'))).toBe(true)
  }
  await full()
  for (const bodyColumns of [52, 30, 44]) {
    await ui.redraw({ ...PANE.props, bodyColumns })
    await full()
  }
  await ui.unmount()
})

test('a status change never shows two drawings of the same piece at once: the old one alone, then the new one alone', async ($, on) => {
  const { clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Switch' }, { do: 'agent', name: 'Tester', status: 'working', task: 'Checking' }] } as never)
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  type El = { type: string; props: Record<string, unknown>; children: unknown[] }
  // The drawings a draw shows: every Svg not inside a Box with display none.
  const shownAlts = async () => {
    const roots = await ui.findAll({ type: 'Box' })
    const hidden = new Set<string>()
    const walk = (el: El, under: boolean) => {
      const hide = under || (el.type === 'Box' && el.props.display === 'none')
      if (el.type === 'Svg' && hide) hidden.add(String(el.props.source))
      for (const child of el.children ?? []) if (child && typeof child === 'object' && 'type' in child) walk(child as El, hide)
    }
    for (const root of roots) walk(root as unknown as El, false)
    return (await ui.findAll({ type: 'Svg' })).filter(found => !hidden.has(String(found.props.source))).map(found => String(found.props.alt))
  }
  const agentsShown = async () => (await shownAlts()).filter(alt => alt.startsWith('Agents.'))
  expect(await agentsShown()).toHaveLength(1)
  for (const status of ['needs_user', 'working', 'in_review', 'done']) {
    await $.tool.call({ tool: TOOL, updates: [{ do: 'agent', name: 'Tester', status, task: `Now ${status}` }] } as never)
    // Every draw through the change: right after it, mid-way, and once the old one is gone.
    for (const step of [10, 200, 300]) {
      await clock.advance(step)
      await ui.redraw()
      const shown = await agentsShown()
      expect(shown).toHaveLength(1)
    }
    // Once done, the one shown is the new one.
    expect((await agentsShown())[0]).toContain(`Tester: ${status.replace('_', ' ')}`)
  }
  await ui.unmount()
})

// ---- the orchestrator's own status: resets, its turn, the order, the words that fit ----------------

/** Reports applied in order by the writer's own rules, a millisecond apart from `at`. */
const applied = (start: McState, updates: Report[], at: number): McState =>
  updates.reduce((state, update, index) => {
    const result = apply(state, update, at + index, () => `id${index}`)
    if (result.error !== undefined) throw new Error(result.error)
    return result.state
  }, start)

test('task.done, task.fail and task.start reset the orchestrator\'s own status, with no agent changing', () => {
  const at = Date.UTC(2026, 0, 1, 9)
  const statusOf = (state: McState) => orchestratorOf(state).status
  let state = applied(emptyState(at), [{ do: 'task.start', title: 'Solo' }, { do: 'orch', status: 'planning' }], at)
  expect(statusOf(state)).toBe('planning')
  state = applied(state, [{ do: 'task.done' }], at + 100)
  expect(statusOf(state)).toBe('done')
  state = applied(state, [{ do: 'task.start', title: 'Solo 2' }], at + 200)
  expect(statusOf(state)).toBe('idle')
  state = applied(state, [{ do: 'orch', status: 'dispatching' }, { do: 'task.fail' }], at + 300)
  expect(statusOf(state)).toBe('idle')
  // A turn running through them is kept.
  state = applied(turnState(state, true, at + 400), [{ do: 'task.start', title: 'Solo 3' }, { do: 'orch', status: 'planning' }, { do: 'task.done' }], at + 500)
  expect(state.orchestrator.turn).toBe(at + 400)
  expect(statusOf(state)).toBe('done')
})

test('the order: asking, review, its turn (its own planning or briefing, else working), waiting, done, idle', () => {
  const at = Date.UTC(2026, 0, 1, 9)
  const statusOf = (state: McState) => orchestratorOf(state).status
  const base = applied(emptyState(at), [{ do: 'task.start', title: 'T' }, { do: 'agent', name: 'Tester', status: 'working', task: 'x' }], at)
  // Its turn running, an agent working: WORKING, not WAITING.
  const turn = turnState(base, true, at + 100)
  expect(statusOf(turn)).toBe('working')
  // Reviewing beats working.
  expect(statusOf(applied(turn, [{ do: 'agent', name: 'Tester', status: 'in_review', task: 'Reported' }], at + 200))).toBe('reviewing')
  // A planning or dispatching set in this turn beats working; one set before the turn does not.
  expect(statusOf(applied(turn, [{ do: 'orch', status: 'planning' }], at + 200))).toBe('planning')
  expect(statusOf(applied(turn, [{ do: 'orch', status: 'dispatching' }], at + 200))).toBe('dispatching')
  const setBefore = turnState(applied(base, [{ do: 'orch', status: 'planning' }], at + 50), true, at + 100)
  expect(statusOf(setBefore)).toBe('working')
  // Asking beats review.
  const asking = applied(turn, [{ do: 'agent', name: 'Security', status: 'in_review', task: 'r' }, { do: 'orch', status: 'needs_user' }], at + 200)
  expect(statusOf(asking)).toBe('needs_user')
  // The turn ends: its planning is dropped, and with an agent working it is WAITING.
  const ended = turnState(applied(turn, [{ do: 'orch', status: 'planning' }], at + 200), false, at + 300)
  expect(orchestratorOf(ended)).toMatchObject({ status: 'waiting', waitingOn: ['Tester'] })
  expect(ended.orchestrator.turn).toBeUndefined()
  // Nobody working, no task: IDLE after the turn; DONE stays after task.done until the next turn.
  const idle = turnState(turnState(emptyState(at), true, at + 10), false, at + 20)
  expect(statusOf(idle)).toBe('idle')
  const done = turnState(applied(turnState(base, true, at + 100), [{ do: 'task.done' }], at + 200), false, at + 300)
  expect(statusOf(done)).toBe('done')
  expect(statusOf(turnState(done, true, at + 400))).toBe('working')
})

test('the orchestrator alone: WORKING while its turn runs, task or no task, and dropped at its end', async ($, on) => {
  const { files, clock } = engine(on)
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const orchestrator = () => JSON.parse(files.get(STATE) ?? 'null').orchestrator
  const stop = () => $.classic.Stop({ stop_hook_active: false } as never)
  // Its first report marks it the orchestrator; that turn ends.
  await $.tool.call({ tool: TOOL, updates: [{ do: 'heartbeat' }] } as never)
  await stop()
  expect(orchestrator()).toMatchObject({ status: 'idle' })
  // A new turn, no task: WORKING in the circle, and no task is made.
  await $.prompt.submit({ text: 'Look into the header', wait: false, origin: { kind: 'person' } } as never)
  expect(orchestrator()).toMatchObject({ status: 'working' })
  expect(JSON.parse(files.get(STATE) ?? 'null').task).toBeNull()
  await clock.advance(10)
  expect((await drawn($)).svg).toContain('>WORKING<')
  await stop()
  expect(orchestrator()).toMatchObject({ status: 'idle' })
  expect(orchestrator().turn).toBeUndefined()
  // A solo task: its planning shows in its turn; task.done shows DONE, and the circle keeps it after the turn.
  await $.prompt.submit({ text: 'Fix it', wait: false, origin: { kind: 'person' } } as never)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Fix the header' }, { do: 'orch', status: 'planning' }] } as never)
  expect(orchestrator()).toMatchObject({ status: 'planning' })
  await clock.advance(10)
  expect((await drawn($)).svg).toContain('>PLANNING<')
  await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.done' }] } as never)
  expect(orchestrator()).toMatchObject({ status: 'done' })
  await stop()
  expect(orchestrator()).toMatchObject({ status: 'done' })
  await clock.advance(10)
  expect((await drawn($)).svg).toContain('>DONE<')
  // A planning left at the end of a turn is dropped.
  await $.prompt.submit({ text: 'Next', wait: false, origin: { kind: 'person' } } as never)
  await $.tool.call({ tool: TOOL, updates: [{ do: 'task.start', title: 'Next' }, { do: 'orch', status: 'planning' }] } as never)
  await stop()
  expect(orchestrator()).toMatchObject({ status: 'idle' })
})

test("a helper's session never writes the orchestrator's status or turn", async ($, on) => {
  const { files, clock } = engine(on)
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.Stop', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const stored = {
    task: { id: 't', title: 'Audit', status: 'running', startedAt: 1 },
    plan: null,
    queue: [],
    agents: [{ id: 'explorer', name: 'Explorer', status: 'working', currentTask: 'Auditing', startedAt: 1 }],
    orchestrator: { status: 'waiting', waitingOn: ['Explorer'], reviewing: [] },
    lastUpdated: clock.now(),
  }
  files.set(STATE, JSON.stringify(stored))
  await $.prompt.submit({ text: 'Audit the instructions. Report progress with: mc.py say --as explorer "..."', wait: false, origin: { kind: 'peer' } } as never)
  await clock.advance(10)
  await $.tool.call({ tool: 'Grep', pattern: 'x' } as never)
  await $.tool.call({ tool: TOOL, as: 'explorer', updates: [{ do: 'say', text: 'Reading the rules' }] } as never)
  await $.classic.Stop({ stop_hook_active: false } as never)
  await clock.advance(10)
  const after = JSON.parse(files.get(STATE) ?? 'null').orchestrator
  expect(after.turn).toBeUndefined()
  expect(after.status).toBe('waiting')
})

test('every word in the circle is at most 9 characters and fits the disc with 8px on each side', () => {
  expect(ORCH_ROOM).toBe(ORCH_DISC_R * 2 - 16)
  for (const word of Object.values(ORCH_LABELS)) {
    expect(word.length).toBeLessThanOrEqual(9)
    expect(word).toBe(word.toUpperCase())
    // At the circle's font size (the first of its sizes it fits at), never the line under the ring.
    const fits = ORCH_SIZES.find(({ size, tracking }) => orchWordWidth(word, size, tracking) <= ORCH_ROOM)
    expect(fits).toBeDefined()
  }
  expect(Object.values(ORCH_LABELS)).toEqual(['IDLE', 'PLANNING', 'BRIEFING', 'WORKING', 'WAITING', 'REVIEWING', 'NEEDS YOU', 'DONE'])
})

test('the circle takes the needs-you colour and tint for needs_user, and its own purple for every other status', async ($, on) => {
  // The circle itself, in both themes.
  for (const T of [DARK, LIGHT]) {
    const needs = orchestratorNode(T, 100, 100, '', '', true)
    expect(needs).toContain(`stroke="${T.needs}"`)
    expect(needs).toContain(`fill="${T.needsFill}"`)
    expect(needs).not.toContain(T.orch)
    expect(needs).not.toContain(T.orchFill)
    const usual = orchestratorNode(T, 100, 100, '', '')
    expect(usual).toContain(`stroke="${T.orch}"`)
    expect(usual).toContain(`fill="${T.orchFill}"`)
    expect(usual).not.toContain(T.needs)
  }
  // In the pane: needs_user draws it so (and its word in the needs-you ink); any other status, purple.
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const statuses = ['idle', 'planning', 'dispatching', 'working', 'waiting', 'reviewing', 'done', 'needs_user'] as const
  for (const status of statuses) {
    files.set(STATE, JSON.stringify({ task: { id: 't', title: 'T', status: 'running', startedAt: 1 }, plan: null, queue: [], agents: [], orchestrator: { status, waitingOn: [], reviewing: [], since: clock.now() }, lastUpdated: clock.now() }))
    await clock.advance(1100)
    // A changed drawing keeps its predecessor beside it for GHOST_MS: draw again once that has passed.
    await drawn($)
    await clock.advance(500)
    const { svg } = await drawn($)
    const shown = orchestratorOf(JSON.parse(files.get(STATE) ?? 'null') as McState).status
    for (const T of [DARK, LIGHT]) {
      if (shown === 'needs_user') {
        expect(svg).toContain(`fill="${T.needsFill}"`)
        expect(svg).toContain(`fill="${T.ink.needs}"`)
        expect(svg).not.toContain(`fill="${T.orchFill}"`)
      } else {
        expect(svg).toContain(`fill="${T.orchFill}"`)
        expect(svg).not.toContain(`fill="${T.needsFill}"`)
      }
    }
  }
})

test('a short graph shrinks the orchestrator\'s circle if it must to keep 12px clear; at the owner\'s size the disc is 32', async ($, on) => {
  // The shortest graph: every gap at least 12px, and every word still fits the smaller disc.
  const short = orchCircleFor(124)
  expect(short.disc).toBeLessThanOrEqual(ORCH_DISC_R)
  for (const gap of Object.values(short.gaps)) expect(gap).toBeGreaterThanOrEqual(ORCH_CLEAR - 1e-9)
  for (const word of Object.values(ORCH_LABELS)) expect(ORCH_SIZES.some(({ size, tracking }) => orchWordWidth(word, size, tracking) <= orchRoomOf(short.disc))).toBe(true)
  // The design's graph and taller: exactly 32.
  expect(ORCH_DISC_R).toBe(32)
  for (const g of [140, 200, 360]) expect(orchCircleFor(g).disc).toBe(ORCH_DISC_R)
  // The owner's pane (39 rows): the circle is drawn at 32 (its scale from the design's 22).
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  files.set(STATE, JSON.stringify({ task: { id: 't', title: 'T', status: 'running', startedAt: 1 }, plan: null, queue: [], agents: [], orchestrator: { status: 'idle', waitingOn: [], reviewing: [] }, lastUpdated: clock.now() }))
  await clock.advance(1100)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 43, scroll: { offset: 0, bodyRows: 39 } } })
  const svg = (await ui.findAll({ type: 'Svg' })).map(found => String(found.props.source)).join('\n')
  await ui.unmount()
  expect(svg).toContain(`scale(${ORCH_DISC_R / 22}) translate(-46.625 -46.625)`)
})

test('the Activity view: each sender\'s dot and name in its own colour, in both themes; the list under the bar at the section spacing', () => {
  const at = Date.UTC(2026, 0, 1, 9)
  const senders: [string, keyof typeof DARK.actor][] = [
    ['user', 'user'],
    ['orchestrator', 'orchestrator'],
    ['explorer', 'explorer'],
    ['worker', 'worker'],
    ['tester', 'tester'],
    ['security', 'security'],
    ['scout', 'other'],
  ]
  // Oldest first in the log; the newest is the last one, from the user.
  const events: McEvent[] = [...senders].reverse().map(([from], index) => ({ time: at + index * 120_000, type: 'report', from, to: '', text: `From ${from}` }))
  const data: MissionData = { loaded: true, state: null, events, eventCount: events.length, fresh: [], readAt: at + 3_600_000, offline: false, aliveAt: at }
  for (const T of [DARK, LIGHT]) {
    const { svg } = timeline(data, at + 3_600_000, T.name)
    for (const [from, actor] of senders) {
      const name = `${from[0]?.toUpperCase() ?? ''}${from.slice(1)}`
      expect(svg).toMatch(new RegExp(`fill="${T.actor[actor]}"[^>]*>${name}<`))
      expect(svg).toMatch(new RegExp(`<circle cx="61.5"[^>]*fill="${T.actor[actor]}"`))
    }
    expect(T.actor.other).toBe(T.name === 'dark' ? '#93A0B8' : '#4B5568')
    // None is a status token.
    for (const colour of Object.values(T.actor)) expect([T.needs, T.review, T.done, T.ink.needs, T.ink.review, T.ink.done]).not.toContain(colour)
    // The gap: the summary keeps SECTION_GAP under its bar, and the list's first row starts SECTION_GAP down.
    expect(svg).toContain(`y="${baseline(SECTION_GAP, 12, 10)}"`)
    const summary = activitySummary(data, at, T.name)
    expect(summary.height).toBe(16 + 19 + 10 + 3 + SECTION_GAP + 1)
  }
})

test('the Activity view as the pane receives it: nothing between the summary and the list adds space, each drawing at its own height, pinned to the top', async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  files.set(STATE, JSON.stringify({ task: { id: 't', title: 'Fix the header', status: 'running', startedAt: 1 }, plan: [{ id: 's1', label: 'A', status: 'active' }, { id: 's2', label: 'B', status: 'pending' }], queue: [], agents: [], orchestrator: { status: 'idle', waitingOn: [], reviewing: [] }, lastUpdated: clock.now() }))
  files.set(EVENTS, Array.from({ length: 40 }, (_, i) => JSON.stringify({ time: clock.now() - (40 - i) * 60_000, type: 'report', from: i % 2 ? 'worker' : 'orchestrator', to: '', text: 'A line long enough to wrap onto a second line in the list here' })).join('\n') + '\n')
  await clock.advance(1100)
  // The owner's pane (43 columns, 39 rows: scale 1) and a narrow one (30 columns: scaled down).
  for (const columns of [43, 30]) {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: columns, scroll: { offset: 0, bodyRows: 39 } } })
    // The view is kept between mounts: open it once.
    if (await ui.find({ key: 'mission-open-activity' })) await ui.press({ key: 'mission-open-activity' })
    await clock.advance(10)
    expect(await ui.find({ key: 'mission-back' })).toBeDefined()
    type Node = { type?: string; props?: Record<string, unknown>; children?: unknown }
    const kids = (node: Node): Node[] => {
      const children = node.children ?? node.props?.children
      return (Array.isArray(children) ? children : children === undefined ? [] : [children]).filter((kid): kid is Node => typeof kid === 'object' && kid !== null)
    }
    const svgsIn = (node: Node): Node[] => (node.type === 'Svg' ? [node] : kids(node).flatMap(svgsIn))
    const root = (await ui.drawn()) as Node
    const column = kids(root)[0] as Node
    const sections = kids(column)
    // The header row, the summary's slot, the list's slot: nothing else, and no slot that adds space.
    expect(sections).toHaveLength(3)
    for (const slot of sections.slice(1)) {
      for (const node of [slot, ...kids(slot)]) {
        for (const prop of ['gap', 'rowGap', 'minHeight', 'height', 'flexGrow', 'marginTop', 'marginBottom', 'paddingTop', 'paddingBottom', 'justifyContent']) expect(node.props?.[prop]).toBeUndefined()
      }
    }
    const scale = Math.min(1, (columns * 10.68) / 400)
    const [summary, list] = sections.slice(1).map(slot => svgsIn(slot)[0] as Node)
    for (const svg of [summary, list]) {
      const source = String(svg?.props?.source)
      const drawnHeight = Number(source.match(/^<svg[^>]* height="([\d.]+)"/)?.[1])
      expect(Math.abs(Number(svg?.props?.height) - drawnHeight * scale)).toBeLessThan(1e-6)
      expect(source).toMatch(/^<svg[^>]* preserveAspectRatio="xMidYMin meet"/)
    }
    await ui.unmount()
  }
})

test('the dashed ring turns in every orchestrator status, needs_user included, live or not', async ($, on) => {
  const { files, clock } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const statuses = ['idle', 'planning', 'dispatching', 'working', 'waiting', 'reviewing', 'done', 'needs_user'] as const
  // A running task, and a paused one (the pane is not live then: everything else stands still).
  for (const taskStatus of ['running', 'paused'] as const) {
    for (const status of statuses) {
      files.set(STATE, JSON.stringify({ task: { id: 't', title: 'T', status: taskStatus, startedAt: 1, ...(taskStatus === 'paused' ? { pausedAt: 2 } : {}) }, plan: null, queue: [], agents: [], orchestrator: { status, waitingOn: [], reviewing: [], since: clock.now() }, lastUpdated: clock.now() }))
      await clock.advance(1100)
      await drawn($)
      await clock.advance(500)
      const { svg } = await drawn($)
      const shown = orchestratorOf(JSON.parse(files.get(STATE) ?? 'null') as McState).status
      expect(svg).toMatch(new RegExp(`<g class="m spin${shown === 'dispatching' ? ' fast' : ''}" style="animation-delay:-\\d+ms">`))
    }
  }
})
