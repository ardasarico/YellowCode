import { expect, test } from "bun:test"
import { nextMode } from "./settings.ts"

test("Shift+Tab goes auto, accept edits, plan and back; other modes go to auto", () => {
  expect([nextMode("auto"), nextMode("acceptEdits"), nextMode("plan")]).toEqual(["acceptEdits", "plan", "auto"])
  expect([nextMode("default"), nextMode("bypassPermissions"), nextMode(null)]).toEqual(["auto", "auto", "acceptEdits"])
})
