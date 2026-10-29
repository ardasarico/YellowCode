import type { Scenario } from "../scenario.ts"
import { nativeForm, ownAsk } from "./asks.ts"
import { modTool } from "./client-tools.ts"
import { agentModel, models } from "./models.ts"
import { connect } from "./connect.ts"
import { cut, cutElsewhere } from "./cut.ts"
import { lists } from "./lists.ts"
import { permissions } from "./permissions.ts"
import { planFile, planQuestion } from "./plan.ts"
import { rawHello } from "./raw-hello.ts"
import { rawPermission } from "./raw-permission.ts"
import { rawSocket } from "./raw-socket.ts"
import { rawText } from "./raw-text.ts"
import { rawTools } from "./raw-tools.ts"
import { fork, sessions, title } from "./sessions.ts"
import { rules, settings } from "./settings.ts"
import { interrupt, steer } from "./steer.ts"
import { bgShell, bgSubagent, subagent, tools } from "./tools.ts"
import { error, text, twoTurns } from "./turns.ts"
import { compact, compactFailed, usage } from "./usage.ts"

export const scenarios: Scenario[] = [
  rawHello,
  rawText,
  rawTools,
  rawPermission,
  rawSocket,
  connect,
  sessions,
  fork,
  title,
  text,
  twoTurns,
  error,
  tools,
  subagent,
  bgShell,
  bgSubagent,
  permissions,
  steer,
  interrupt,
  ownAsk,
  nativeForm,
  modTool,
  planFile,
  planQuestion,
  cut,
  cutElsewhere,
  usage,
  compact,
  compactFailed,
  models,
  agentModel,
  settings,
  rules,
  lists,
]
