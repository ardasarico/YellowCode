import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/opencode/agent-driver.ts"
import { settings } from "../../../tools/opencode/scenarios/settings.ts"
import type { SettingRow } from "../../agent/settings.ts"
import { allowlistFor } from "./allow.ts"
import { MOCK_KEY, readFixture, secretsIn } from "./fixture.ts"
import { settingRows } from "./settings.ts"
import type { Transport } from "./transport.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = readFixture(readFileSync(join(ROOT, "fixtures", "opencode", "settings.jsonl"), "utf8"))
const USER = { file: "<root>/config/opencode/opencode.json", layer: "user" }
const PROJECT = { file: "<root>/project/opencode.json", layer: "project" }

const valuesOf = (rows: SettingRow[]) =>
  Object.fromEntries(rows.map((row) => [row.id, [row.value, row.writable, row.origin?.layer ?? null]]))

test("the rows come from both config files, and the shell written lands in the user's", async () => {
  const run = await replayAgent((driver) => settings.run(driver), fixture)
  // The read-only row's write sent nothing.
  expect(run.transport.unused()).toEqual([])
  const [before, after] = run.outputs.map((output) => ("settings" in output ? output.settings : []))
  if (!before || !after) throw new Error("two reads expected")
  expect(valuesOf(before)).toEqual({
    shell: ["", true, null],
    "web-search": ["off", false, "user"],
    "compaction.auto": [true, false, "user"],
    "compaction.threshold": [30000, false, "project"],
    "compaction.keep": [8000, false, "user"],
    "tool-output.lines": [500, false, "project"],
    "tool-output.bytes": [null, false, null],
    "images.resize": [null, false, null],
    "images.width": [null, false, null],
    "images.height": [null, false, null],
    "images.size": [null, false, null],
    // The user's file sets enabled_providers, which opencode turns into policies; the project's come first.
    policies: ["deny provider.use openai, deny provider.use *, allow provider.use anthropic", false, "project"],
    "watcher.ignore": ["dist/**, build/**", false, "user"],
    "worktree.directory": ["../trees", false, "project"],
    warming: [false, false, "user"],
    "warming.interval": [null, false, null],
    "warming.duration": [null, false, null],
    "mcp.startup": [20000, false, "user"],
    "mcp.catalog": [null, false, null],
    "mcp.execution": [null, false, null],
  })
  expect(before.find((row) => row.id === "compaction.threshold")?.origin).toEqual(PROJECT)
  const shell = after.find((row) => row.id === "shell")
  expect(shell?.value).toBe("/bin/sh")
  expect(shell?.origin).toEqual(USER)
  expect(shell?.control.type === "choice" && shell.control.options.slice(0, 2)).toEqual([
    { value: "", label: "default" },
    { value: "/bin/bash", label: "bash" },
  ])
})

const answering = (bodies: Record<string, unknown>): Transport => ({
  request: (req) => Promise.resolve({ status: 200, body: bodies[req.path] }),
  events: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
  }),
  socket: () => Promise.reject(new Error("no socket")),
})

test("in a subfolder the repository root's config files are the project's", async () => {
  const transport = answering({
    "/api/location": { directory: "/work/sub", project: { id: "p", directory: "/work", canonical: "/work" } },
    "/api/config": [
      { type: "document", path: "/home/u/.config/opencode/opencode.json", info: { compaction: { auto: true } } },
      { type: "directory", path: "/home/u/.config/opencode" },
      { type: "document", path: "/work/opencode.json", info: { shell: "/bin/zsh" } },
      { type: "document", path: "/work/.opencode/opencode.json", info: { compaction: { buffer: 1000 } } },
    ],
  })
  const rows = await settingRows(transport, "/work/sub")
  if (!rows) throw new Error("no rows")
  const shell = rows.find((row) => row.id === "shell")
  expect([shell?.origin, shell?.overriddenBy]).toEqual([{ file: "/work/opencode.json", layer: "project" }, "project"])
  expect(valuesOf(rows)["compaction.threshold"]).toEqual([1000, false, "project"])
  expect(valuesOf(rows)["compaction.auto"]).toEqual([true, false, "user"])
})

const objectsIn = (value: unknown, seen = new Set<object>()): Set<object> => {
  if (typeof value !== "object" || value === null || seen.has(value)) return seen
  seen.add(value)
  for (const inner of Object.values(value)) objectsIn(inner, seen)
  return seen
}

test("keys, headers and environments in the config reach no row, and no row holds a part of the answer", async () => {
  const headers = { "x-api-key": MOCK_KEY }
  const config = [
    {
      type: "document",
      path: "/home/u/.config/opencode/opencode.json",
      info: {
        shell: "/bin/zsh",
        compaction: { auto: false, buffer: 20000, headers },
        providers: { anthropic: { settings: { apiKey: MOCK_KEY, baseURL: "http://127.0.0.1:1" }, headers } },
        mcp: {
          timeout: { catalog: 5000, headers },
          servers: { s: { type: "local", command: ["x"], environment: { TOKEN: MOCK_KEY } } },
        },
        warming: { prompt: MOCK_KEY, interval: "2 minutes" },
        agents: { build: { options: { apiKey: MOCK_KEY } } },
        websearch: { provider: "exa", apiKey: MOCK_KEY },
      },
    },
  ]
  const shells = [{ path: "/bin/zsh", name: "zsh", acceptable: true, headers }]
  const bodies: Record<string, unknown> = { "/api/config": config, "/api/config/shell": shells }
  const rows = await settingRows(answering(bodies), "/work")
  if (!rows) throw new Error("no rows")
  expect(secretsIn(JSON.stringify(rows))).toEqual([])
  expect(JSON.stringify(rows)).not.toContain("127.0.0.1")
  expect(valuesOf(rows)["web-search"]).toEqual(["exa", false, "user"])
  expect(valuesOf(rows)["compaction.threshold"]).toEqual([20000, false, "user"])
  expect(valuesOf(rows)["mcp.catalog"]).toEqual([5000, false, "user"])
  expect(valuesOf(rows)["warming.interval"]).toEqual(["2 minutes", false, "user"])
  // What the allowlist keeps is all any other code sees of the answer; the rest is no longer reachable from it.
  const answer = objectsIn(bodies)
  for (const [path, body] of Object.entries(bodies)) {
    const kept = allowlistFor(path)?.(body, 200)
    expect([path, secretsIn(JSON.stringify(kept))]).toEqual([path, []])
    expect([path, [...objectsIn(kept)].filter((object) => answer.has(object))]).toEqual([path, []])
  }
  expect([...objectsIn(rows)].filter((object) => answer.has(object))).toEqual([])
})
