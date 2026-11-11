import { expect, test } from "bun:test"
import { instructionsFor } from "../../agent/yellowcode-prompt.ts"
import type { StartOptions } from "../../agent/agent.ts"
import { openArgs, pluginArgs } from "./agent.ts"

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
  skills: [],
  clientTools: [],
  mcpServers: [],
  ephemeral: false,
  plain: false,
}

test("a session pi does not keep, and a plain one, start with their flags", () => {
  const ours = ["--append-system-prompt", instructionsFor([])]
  expect(openArgs(OPTIONS)).toEqual(ours)
  expect(openArgs({ ...OPTIONS, ephemeral: true })).toEqual(["--no-session", ...ours])
  expect(openArgs({ ...OPTIONS, plain: true })).toEqual(["--no-extensions", "--no-mcp", ...ours])
})

test("plugins off keeps pi's built-in extensions, and its MCP only where the start leaves it on", () => {
  const off = { ...OPTIONS, ownPlugins: false }
  expect(pluginArgs(OPTIONS, "1.4.0", [])).toEqual([])
  const builtIn = ["-e", "builtin:llama.cpp", "-e", "builtin:codemode", "-e", "builtin:tool-search"]
  expect(pluginArgs(off, "1.4.0", [])).toEqual(["--no-extensions", ...builtIn, "-e", "builtin:mcp"])
  expect(pluginArgs(off, "1.4.0", ["--no-mcp"])).toEqual(["--no-extensions", ...builtIn])
  expect(pluginArgs(off, "1.3.0", [])).toEqual([])
})
