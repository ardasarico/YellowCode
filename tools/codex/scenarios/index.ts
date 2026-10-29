import type { Scenario } from "../scenario.ts"
import { elicitation, modTool, nativeQuestion, ownAsk, patchApproval, permissions } from "./asks.ts"
import { models, modes, plan, planSteps } from "./modes.ts"
import { modServers } from "./mods.ts"
import { rawHello } from "./raw-hello.ts"
import { rawPatch, rawShell, rawText } from "./raw-turns.ts"
import { connect, fork, sessions } from "./sessions.ts"
import { lists, settings } from "./settings.ts"
import { bgShell, cut, cutElsewhere, cutLegacy, interrupt, queued, steer, stopAgent } from "./steer.ts"
import { mcp, subagent, tools } from "./tools.ts"
import { error, reasoning, text, twoTurns } from "./turns.ts"
import { compact, limits, title, usage } from "./usage.ts"

export const scenarios: Scenario[] = [
  rawHello,
  rawText,
  rawShell,
  rawPatch,
  connect,
  sessions,
  fork,
  text,
  twoTurns,
  reasoning,
  error,
  tools,
  mcp,
  subagent,
  permissions,
  patchApproval,
  ownAsk,
  nativeQuestion,
  elicitation,
  modTool,
  modServers,
  modes,
  models,
  plan,
  planSteps,
  steer,
  queued,
  interrupt,
  cut,
  cutLegacy,
  cutElsewhere,
  bgShell,
  stopAgent,
  usage,
  limits,
  compact,
  title,
  settings,
  lists,
]
