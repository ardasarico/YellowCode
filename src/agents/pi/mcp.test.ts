import { expect, test } from "bun:test"
import type { McpLaunch } from "../../agent/agent.ts"
import { heldIn, piMcp } from "./mcp.ts"
import { mcpOf } from "./tools.ts"

const stdio: McpLaunch = { name: "S", command: "node", args: ["s.js"], env: { TOKEN: "$HOME!x", CMD: "!rm" } }
const sse: McpLaunch = { name: "E", url: "https://e.test", headers: {}, type: "sse" }
const off = { on: false, project: [] }

test("own Off replaces pi's MCP only where our stand-in is checked; values stay literal; SSE is held", () => {
  const given = { mcpServers: [stdio, sse], ownMcp: off, plain: false }
  expect(piMcp(given, "1.4.0")).toEqual({
    flags: ["--no-mcp"],
    extension: {
      servers: { S: { command: "node", args: ["s.js"], env: { TOKEN: "$$HOME!x", CMD: "$!rm" } } },
      replace: true,
    },
    held: [{ name: "E", problem: "Pi cannot connect to an SSE server, so E is off here." }],
  })
  expect(piMcp(given, "1.3.2")).toMatchObject({ flags: [], extension: { replace: false } })
  expect(piMcp({ mcpServers: [], ownMcp: off, plain: false }, "1.4.0")).toEqual({
    flags: ["--no-mcp"],
    extension: null,
    held: [],
  })
  expect(piMcp({ mcpServers: [], plain: false }, "1.4.0")).toEqual({ flags: [], extension: null, held: [] })
  expect(piMcp({ mcpServers: [stdio], ownMcp: off, plain: true }, "1.4.0").extension).toBeNull()
})

test("pi's MCP tool names and our extension's notice", () => {
  expect(mcpOf("mcp__my_server__get__it")).toEqual({ server: "my_server", tool: "get__it" })
  expect(mcpOf("mcp__x")).toBeNull()
  expect(heldIn('yellowcode:mcp-held [{"name":"X","why":"own"}]')).toEqual([
    { name: "X", problem: "Pi's own X is used here; remove it from Pi's mcp.json to use the shared one." },
  ])
  expect(heldIn("X: connected")).toBeNull()
})
