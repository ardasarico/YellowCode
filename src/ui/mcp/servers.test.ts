import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { mcpRows } from "../../agents/claude/mcp-rows.ts"
import { feed } from "../../agents/claude/translate.ts"
import { parse } from "../../protocol/parse.ts"
import { createSession } from "../../session/session.ts"
import type { McpServer } from "../../session/types.ts"
import { parseRecording } from "../../source/recording.ts"
import { mcpEntries } from "./servers.ts"

test("servers group by where they come from, problems first, with short names and their own tools", () => {
  const path = join(import.meta.dir, "..", "..", "..", "fixtures", "sessions", "mcp-states.jsonl")
  const session = createSession()
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries)
    feed(session, entry.dir, parse(entry.line), entry.t)
  const info = session.state.info
  const rows = mcpEntries(mcpRows(info?.mcpServers ?? null, info?.tools ?? [])).map((entry) => [
    entry.group,
    entry.row.label,
    entry.tag,
    entry.row.state,
    entry.tools.length,
  ])
  expect(rows.filter((row) => row[0] === "project")).toEqual([
    ["project", "postgres", "shared", "failed", 0],
    ["project", "server-a", "", "connected", 21],
  ])
  expect(rows.filter((row) => row[0] === "other")).toEqual([
    ["other", "plugin-a", "plugin", "needs-login", 0],
    ["other", "plugin-b", "plugin", "needs-login", 0],
    ["other", "Connector A", "claude.ai", "needs-login", 0],
    ["other", "plugin-c", "plugin", "connected", 1],
    ["other", "server-e", "plugin", "connected", 1],
    ["other", "claude-in-chrome", "built-in", "connected", 8],
    ["other", "Connector B", "claude.ai", "connected", 8],
    ["other", "Connector C", "claude.ai", "off", 0],
  ])
  const odd: McpServer = {
    name: "odd",
    status: "warming-up",
    source: null,
    scope: null,
    error: null,
    config: null,
    serverInfo: null,
    tools: null,
  }
  expect(mcpEntries(mcpRows([odd], []))[0]?.row.state).toBe("unknown")
})
