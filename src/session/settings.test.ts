import { expect, test } from "bun:test"
import { CLAUDE_MODES } from "../agents/claude/lists.ts"
import { modelChoices, nextMode } from "./settings.ts"

const next = (mode: string | null) => nextMode(CLAUDE_MODES, mode)

test("Shift+Tab goes auto, accept edits, plan and back; other modes go to auto", () => {
  expect([next("auto"), next("acceptEdits"), next("plan")]).toEqual(["acceptEdits", "plan", "auto"])
  expect([next("default"), next("bypassPermissions"), next(null)]).toEqual(["auto", "auto", "acceptEdits"])
})

const row = (id: string, resolves: string) => ({
  ref: { provider: null, id },
  label: id,
  note: "",
  resolves,
  efforts: [],
  images: true,
  window: null,
})

test("claude's models are those before its older ones, a new one without a family name too", () => {
  const listed = [
    row("default", "claude-opus-5-5"),
    row("opus", "claude-opus-5-5"),
    row("claude-fable-5-2", "claude-fable-5-2"),
    row("fable", "claude-fable-5-1"),
    row("haiku", "claude-haiku-5-5"),
    row("claude-opus-4-8", "claude-opus-4-8"),
  ]
  expect(modelChoices(listed).map(({ id }) => id)).toEqual([
    "claude-opus-5-5",
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-haiku-5-5",
  ])
})
