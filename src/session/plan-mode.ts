import type { ModeId } from "../agent/ids.ts"
import type { ModeRow } from "../agent/lists.ts"

// After an approved plan the session goes back to the mode it had before plan mode, or to the agent's auto mode when it
// began in plan.
export function planReturn() {
  let before: ModeId | null = null
  let approved = false
  return {
    approve() {
      approved = true
    },
    cancel() {
      approved = false
    },
    // The mode to ask the agent for, if the one it now reports is not the one the session should be in. `modes` are
    // the agent's.
    seen(reported: string, modes: ModeRow[]): ModeId | null {
      const known = modes.find((mode) => mode.id === reported)
      if (known?.kind === "plan") return null
      if (!approved) {
        before = known?.id ?? null
        return null
      }
      approved = false
      const target = before ?? modes.find((mode) => mode.kind === "auto")?.id ?? null
      before = target
      return known?.id === target ? null : target
    },
  }
}
