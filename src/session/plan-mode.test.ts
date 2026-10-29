import { expect, test } from "bun:test"
import { CLAUDE_MODES } from "../agents/claude/lists.ts"
import { planReturn } from "./plan-mode.ts"

test("an approved plan goes back to the mode from before plan mode", () => {
  const back = planReturn()
  back.seen("acceptEdits", CLAUDE_MODES)
  back.seen("plan", CLAUDE_MODES)
  back.approve()
  expect(back.seen("default", CLAUDE_MODES)).toBe("acceptEdits")
  expect(back.seen("acceptEdits", CLAUDE_MODES)).toBeNull()
})

test("a session that began in plan goes to auto", () => {
  const back = planReturn()
  back.seen("plan", CLAUDE_MODES)
  back.approve()
  expect(back.seen("default", CLAUDE_MODES)).toBe("auto")
})

test("leaving plan without an approval is left alone", () => {
  const back = planReturn()
  back.seen("acceptEdits", CLAUDE_MODES)
  back.seen("plan", CLAUDE_MODES)
  expect(back.seen("auto", CLAUDE_MODES)).toBeNull()
})

test("claude already restoring the mode asks for nothing", () => {
  const back = planReturn()
  back.seen("auto", CLAUDE_MODES)
  back.seen("plan", CLAUDE_MODES)
  back.approve()
  expect(back.seen("auto", CLAUDE_MODES)).toBeNull()
})
