import type { RGBA } from "@opentui/core"
import { theme } from "../theme/theme.ts"

const PLACES: Record<string, number> = { opencode: 2 }

// Claude keeps its own color; any other agent always gets the same one of the theme's agent colors.
export function agentColor(agent: string): RGBA {
  if (agent === "claude") return theme.claude
  let place = PLACES[agent]
  if (place === undefined) {
    place = 0
    for (let index = 0; index < agent.length; index++) place += agent.charCodeAt(index)
  }
  return theme.agents[place % theme.agents.length] ?? theme.accent
}
