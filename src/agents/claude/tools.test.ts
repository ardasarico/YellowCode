import { expect, test } from "bun:test"
import { mcpOf } from "./tools.ts"

test("mcpOf splits MCP tool names at the first server boundary", () => {
  expect(mcpOf("mcp__github__list_pull_requests")).toEqual({ server: "github", tool: "list_pull_requests" })
  expect(mcpOf("mcp__my_db__run__query")).toEqual({ server: "my_db", tool: "run__query" })
  expect(["Read", "mcp__echo", "mcp__echo__", "mcp_x__y"].map(mcpOf)).toEqual([null, null, null, null])
})
