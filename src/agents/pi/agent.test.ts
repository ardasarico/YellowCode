import { expect, test } from "bun:test"
import type { StartOptions } from "../../agent/agent.ts"
import { openArgs } from "./agent.ts"

const OPTIONS: StartOptions = {
  cwd: "/project",
  resume: null,
  mode: null,
  defaultMode: null,
  model: null,
  effort: null,
  extraEffort: false,
  thinking: false,
  instructions: [],
  clientTools: [],
  mcpServers: [],
  ephemeral: false,
  plain: false,
}

test("a session pi does not keep, and a plain one, start with their flags", () => {
  expect(openArgs(OPTIONS)).toEqual([])
  expect(openArgs({ ...OPTIONS, ephemeral: true })).toEqual(["--no-session"])
  expect(openArgs({ ...OPTIONS, plain: true })).toEqual(["--no-extensions", "--no-mcp"])
})
