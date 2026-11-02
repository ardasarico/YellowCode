import type { Scenario } from "../scenario.ts"
import { abort, followUp, steer } from "./steer.ts"
import { dialogs } from "./dialogs.ts"
import { fork } from "./sessions.ts"
import { bash, edits } from "./tools.ts"
import { error, hello, reasoning, twoTurns } from "./turns.ts"

export const scenarios: Scenario[] = [
  hello,
  reasoning,
  twoTurns,
  error,
  bash,
  edits,
  steer,
  followUp,
  abort,
  fork,
  dialogs,
]
