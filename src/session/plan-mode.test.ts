import { expect, test } from "bun:test"
import { planReturn } from "./plan-mode.ts"

test("an approved plan goes back to the mode from before plan mode", () => {
  const back = planReturn()
  back.seen("acceptEdits")
  back.seen("plan")
  back.approve()
  expect(back.seen("default")).toBe("acceptEdits")
  expect(back.seen("acceptEdits")).toBeNull()
})

test("a session that began in plan goes to auto", () => {
  const back = planReturn()
  back.seen("plan")
  back.approve()
  expect(back.seen("default")).toBe("auto")
})

test("leaving plan without an approval is left alone", () => {
  const back = planReturn()
  back.seen("acceptEdits")
  back.seen("plan")
  expect(back.seen("auto")).toBeNull()
})

test("claude already restoring the mode asks for nothing", () => {
  const back = planReturn()
  back.seen("auto")
  back.seen("plan")
  back.approve()
  expect(back.seen("auto")).toBeNull()
})
