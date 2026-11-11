/**
 * The landing hold: an event that fires a shot (draw.ts `packets`) changes how its agent looks only
 * when the shot lands, so card, node, line, legend and the circle's word switch together, on
 * arrival. Display only: the data stay as they are. Pure, no `$`.
 */

import type { McAgent, McEvent } from './model'

/** What an agent showed before its shots, and what each shot brings when it lands. */
export type Hold = { before: McAgent | null; steps: { at: number; look: McAgent }[] }

/** Whom an event's shot is for (by lower-case name): none for one that fires no shot. */
export const shotTargets = (event: McEvent): string[] => {
  switch (event.type) {
    case 'dispatch':
    case 'handoff':
      return [event.to.toLowerCase()]
    case 'report':
    case 'needs_user':
      return [event.from.toLowerCase()]
    case 'agent_done':
      return event.from.trim().toLowerCase() !== 'orchestrator'
        ? [event.from.toLowerCase()]
        : (/^Accepted: (.+)$/.exec(event.text)?.[1]?.split(',') ?? []).map(name => name.trim().toLowerCase()).filter(Boolean)
    default:
      return []
  }
}

/** The look an event gives its agent when its shot lands, over the look it had. */
const lookAfter = (base: McAgent, event: McEvent, at: number): McAgent => {
  const status = { dispatch: 'working', handoff: 'working', report: 'in_review', needs_user: 'needs_user', agent_done: 'done' }[event.type as string] as McAgent['status'] | undefined
  if (!status) return base
  const words = event.type === 'agent_done' && (event.text === 'Accepted' || event.text.startsWith('Accepted: ')) ? base.currentTask : event.text
  return { ...base, status, currentTask: words, startedAt: at }
}

/**
 * Holds for the shots just fired (`landed`: each new event with when its shot lands), over the ones
 * still running. Each agent keeps the look it was last drawn with (`shown`) until its first shot
 * lands; a later shot on its line adds a step that lands after it.
 */
export function addHolds(holds: Map<string, Hold>, landed: { event: McEvent; at: number }[], shown: Map<string, McAgent>): Map<string, Hold> {
  const next = new Map(holds)
  for (const { event, at } of landed) {
    for (const name of shotTargets(event)) {
      const hold = next.get(name) ?? { before: shown.get(name) ?? null, steps: [] }
      const base = hold.steps.at(-1)?.look ?? hold.before ?? { id: name, name, status: 'idle' as const, currentTask: '', startedAt: at }
      next.set(name, { before: hold.before, steps: [...hold.steps, { at, look: lookAfter(base, event, at) }] })
    }
  }
  return next
}

/**
 * The agents as the pane draws them at `now`: a held agent with the look it had, or the look its
 * last landed shot brought; the real one once its last shot has landed (the hold is then dropped).
 * `lead`: how much earlier than the landing to switch, so a drawing that appears that much after it
 * is drawn (swap.ts's hold-back) lands with the shot. Also the next time a held look switches.
 */
export function heldAgents(agents: McAgent[], holds: Map<string, Hold>, now: number, lead: number): { agents: McAgent[]; holds: Map<string, Hold>; nextAt: number | null } {
  const kept = new Map<string, Hold>()
  let nextAt: number | null = null
  const shownAgents = agents.flatMap(agent => {
    const hold = holds.get(agent.name.toLowerCase())
    const last = hold?.steps.at(-1)
    if (!hold || !last || now >= last.at - lead) return [agent]
    kept.set(agent.name.toLowerCase(), hold)
    const landed = hold.steps.filter(step => now >= step.at - lead).at(-1)
    const coming = hold.steps.find(step => now < step.at - lead)
    if (coming) nextAt = Math.min(nextAt ?? Infinity, coming.at - lead)
    const look = landed?.look ?? hold.before
    // Not drawn before its first shot: not drawn until it lands.
    return look ? [{ ...look, ...(agent.taskId === undefined ? {} : { taskId: agent.taskId }) }] : []
  })
  return { agents: shownAgents, holds: kept, nextAt }
}
