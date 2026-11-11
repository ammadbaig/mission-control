import type { Register } from 'claude-code'

import { registerAuto } from './mission/auto'
import { endMission, registerMission, registerTool, startMission } from './mission'

/** Mission Control: the pane, its `/mission` command, the `report` tool and the contract. */
export const register: Register = (on, options) => {
  registerMission(on, options)
  // Automatic reporting: dispatches and reports from the briefs and notes this session sees.
  registerAuto(on)
  on('session.start', async ($, e, next) => {
    await startMission($)
    const started = await next(e)
    // The session is bound now, so the tool can be declared.
    await registerTool($).catch(() => undefined)
    return started
  })
  on('session.end', async ($, e, next) => {
    endMission($)
    return next(e)
  })
}
