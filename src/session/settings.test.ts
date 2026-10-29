import { expect, test } from "bun:test"
import { CLAUDE_MODES } from "../agents/claude/lists.ts"
import { nextMode } from "./settings.ts"

const next = (mode: string | null) => nextMode(CLAUDE_MODES, mode)

test("Shift+Tab goes auto, accept edits, plan and back; other modes go to auto", () => {
  expect([next("auto"), next("acceptEdits"), next("plan")]).toEqual(["acceptEdits", "plan", "auto"])
  expect([next("default"), next("bypassPermissions"), next(null)]).toEqual(["auto", "auto", "acceptEdits"])
})
