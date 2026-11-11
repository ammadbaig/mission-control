/**
 * A helper session's state, read from the end of its transcript (`<config>/projects/<folder>/<id>.jsonl`,
 * which Claude Code appends to as the session runs). Only the last part of the file is read: the
 * files run to tens of megabytes, past what one read may take.
 *
 * The rules: a turn has ended when the last assistant entry stopped for any reason but a tool call
 * or a server pause (`tool_use`, `pause_turn`) and no user entry (a tool result, a new message, a stop hook sending it back)
 * came after it, or when the person interrupted it. Nothing the session said is kept. Anything else is a turn still running, a long
 * tool call included. Entries of other kinds (system notes, attachments, request records) say
 * nothing either way and are passed over.
 */

export type Turn = {
  /** `unknown` when the part read holds no user or assistant entry. */
  state: 'running' | 'ended' | 'unknown'
  /** When the running turn began: its first entry in the part read (the turn may be older still). */
  startedAt: number
  /** When the ended turn ended. */
  endedAt: number
  /** When its last entry was written: a later entry is an answer to a question asked before it. */
  lastAt: number
  /**
   * A question to the person it is waiting on, in its own words: the "next step" question its
   * ended turn asked (`wrap_up` with `ask`), or a question tool still waiting for its answer
   * (`AskUserQuestion` with no result). Only these explicit forms count, never a final message that
   * happens to end with a question mark. '' when there is none.
   */
  question: string
  /**
   * The tool call the running turn waits on: its last entry is a call with no result yet, and when
   * it was made. Null otherwise. Only its name is kept, never its input.
   */
  pending: { name: string; at: number } | null
}

type Entry = { type?: unknown; isSidechain?: unknown; isMeta?: unknown; timestamp?: unknown; message?: { stop_reason?: unknown; content?: unknown; id?: unknown } }
type ToolUse = { name: string; input: Record<string, unknown> }

/** The tool calls in an entry. */
const toolUsesOf = (entry: Entry): ToolUse[] => {
  const content = entry.message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((block: unknown): block is { type: 'tool_use'; name?: unknown; input?: unknown } => Boolean(block) && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use')
    .map(block => ({ name: typeof block.name === 'string' ? block.name : '', input: block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {} }))
}

/** The question a tool call puts to the person, or ''. */
const questionOf = (use: ToolUse): string => {
  // The app's end-of-turn "next step" box: wrap_up (by whatever server prefix) with an ask.
  if (/(^|__)wrap_up$/.test(use.name) && typeof use.input.ask === 'string') return use.input.ask.trim()
  if (isAskTool(use)) {
    const first: unknown = Array.isArray(use.input.questions) ? use.input.questions[0] : undefined
    const asked = first && typeof first === 'object' ? (first as { question?: unknown }).question : use.input.question
    return typeof asked === 'string' ? asked.trim() : ''
  }
  return ''
}

/** The question tool, which waits mid-turn for the person's choice. */
const isAskTool = (use: ToolUse): boolean => use.name === 'AskUserQuestion'

/** Whether an entry is a person's (or a peer's) message, not a tool's result. */
const isPrompt = (entry: Entry): boolean => {
  if (entry.type !== 'user') return false
  const content = entry.message?.content
  return typeof content === 'string' || (Array.isArray(content) && !content.some((block: unknown) => Boolean(block) && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result'))
}

const timeOf = (entry: Entry): number => {
  const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  return Number.isFinite(time) ? time : 0
}

const textOf = (entry: Entry): string => {
  const content = entry.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
    .join('')
}

/**
 * Whether an entry ends a turn: an answer that stopped for any reason but a tool call or a server
 * pause (`tool_use`, `pause_turn`: the turn goes on), such as end_turn, max_tokens, stop_sequence or
 * a refusal; or the person stopping it. An answer with no stop reason yet is still being written.
 */
const GOES_ON = new Set(['tool_use', 'pause_turn'])
const ends = (entry: Entry): boolean => {
  const stop = entry.message?.stop_reason
  if (entry.type === 'assistant') return typeof stop === 'string' && !GOES_ON.has(stop)
  return entry.type === 'user' && /^\[Request interrupted by user/.test(textOf(entry).trim())
}

/** The user and assistant entries of the main thread, oldest first; a cut first line is skipped. */
function entriesOf(tail: string): Entry[] {
  const entries: Entry[] = []
  for (const line of tail.split('\n')) {
    if (!line.startsWith('{')) continue
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue
    }
    if ((entry.type === 'user' || entry.type === 'assistant') && entry.isSidechain !== true && entry.isMeta !== true && !isLocalCommand(entry)) entries.push(entry)
  }
  return entries
}

/**
 * A slash command the person ran in that session (`/mission`, say) and its output: written as user
 * entries the model never answers. Not a turn, so they are passed over: the session stands as its
 * last real turn left it (ended, usually), and no old brief comes back to life.
 */
const LOCAL = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/
const isLocalCommand = (entry: Entry): boolean => entry.type === 'user' && LOCAL.test(textOf(entry))

export function turnOf(tail: string): Turn {
  const entries = entriesOf(tail)
  const last = entries.at(-1)
  if (!last) return { state: 'unknown', startedAt: 0, endedAt: 0, lastAt: 0, question: '', pending: null }
  const lastAt = timeOf(last)
  // Ended: only when, and a question it asked at the end (never anything else it said).
  if (ends(last)) {
    let question = ''
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (!entry || (index < entries.length - 1 && (ends(entry) || isPrompt(entry)))) break
      // Only the next-step question: a question tool earlier in the turn already has its answer.
      for (const use of toolUsesOf(entry)) if (!isAskTool(use)) question ||= questionOf(use)
      if (question) break
    }
    return { state: 'ended', startedAt: 0, endedAt: lastAt, lastAt, question, pending: null }
  }
  // Waiting on a question tool: its call is the last entry, with no result yet.
  const asking = last.type === 'assistant' ? toolUsesOf(last).map(questionOf).find(Boolean) ?? '' : ''
  // Running: the turn began with the first entry after the previous turn's end.
  let startedAt = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (!entry) break
    if (ends(entry)) break
    startedAt = timeOf(entry)
  }
  // A call with no result yet: the last entry is the model's, stopped for its tool call.
  const calls = last.type === 'assistant' ? toolUsesOf(last) : []
  const call = calls[calls.length - 1]
  const pending = call ? { name: call.name, at: lastAt } : null
  return { state: 'running', startedAt, endedAt: 0, lastAt, question: asking, pending }
}

/** A session's transcript folder name: its working folder with every other character a dash. */
export const projectFolderOf = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
