import { expect, test } from "bun:test"
import { instructionsFor } from "../../agent/yellowcode-prompt.ts"
import type { StartOptions } from "../../agent/agent.ts"
import { memoryLaunch } from "../../memory/server.ts"
import { MEMORY_SERVER } from "../../memory/tools.ts"
import { openArgs, pluginArgs } from "./agent.ts"
import { piMcp } from "./mcp.ts"

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

test("the memory server reaches pi with plugins off, whether pi's own MCP is on or off", () => {
  for (const ownMcp of [undefined, { on: false, project: [] }]) {
    const options = { ...OPTIONS, ownPlugins: false, ownMcp, mcpServers: [memoryLaunch("/memory")] }
    const mcp = piMcp(options, "1.4.0")
    const args = pluginArgs(options, "1.4.0", mcp.flags)
    expect(mcp.extension?.servers).toHaveProperty(MEMORY_SERVER)
    expect(args).toContain("builtin:codemode")
    expect(mcp.extension?.replace || args.includes("builtin:mcp")).toBe(true)
  }
})
