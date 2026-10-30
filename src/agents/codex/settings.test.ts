import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/codex/agent-driver.ts"
import type { AgentScenario } from "../../../tools/codex/scenario.ts"
import { lists, settings } from "../../../tools/codex/scenarios/settings.ts"
import type { SettingRow } from "../../agent/settings.ts"
import { createSession } from "../../session/session.ts"
import { allowedConfig } from "./allow.ts"
import { readFixture } from "./fixture.ts"
import { createSettings } from "./settings.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "codex", `${name}.jsonl`), "utf8"))

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

// Written again only with UPDATE_CODEX_GOLDENS=1.
async function replayed(scenario: AgentScenario) {
  const store = createSession({ starting: true })
  const run = await replayAgent((driver) => scenario.run(driver), fixture(scenario.name), { store })
  expect(run.transports.map((transport) => transport.unused())).toEqual(run.transports.map(() => []))
  const events = run.events.filter((event) => event.type !== "seen")
  const got = `${JSON.stringify({ events, outputs: run.outputs, state: store.state }, null, 2)}\n`
  const golden = join(ROOT, "fixtures", "goldens", "codex", `${scenario.name}.json`)
  if (process.env["UPDATE_CODEX_GOLDENS"] === "1") {
    mkdirSync(join(golden, ".."), { recursive: true })
    writeFileSync(golden, got)
  }
  expect(got).toBe(readFileSync(golden, "utf8"))
  return run
}

const user = { type: "user", file: "/home/u/.codex/config.toml", profile: null }
const PLANTED = ["planted-provider", "PLANTED_KEY", "planted-env", "planted-otel", "planted-layer", "Bearer"]

// A reply with every kind of secret config.toml can hold, in the config, its origins and its layers.
const REPLY = {
  config: {
    web_search: "live",
    model_verbosity: 7,
    allow_login_shell: true,
    model_providers: {
      mock: {
        name: "Mock",
        base_url: "http://x",
        env_key: "PLANTED_KEY",
        http_headers: { Authorization: "Bearer planted-provider" },
      },
    },
    mcp_servers: { s: { command: "x", env: { PLANTED_KEY: "planted-env" }, bearer_token: "planted-env" } },
    otel: { exporter: { "otlp-http": { endpoint: "http://y", headers: { "x-key": "planted-otel" } } } },
    shell_environment_policy: { set: { PLANTED_KEY: "planted-env" } },
  },
  origins: {
    web_search: { name: user, version: "v1" },
    "mcp_servers.s.env.PLANTED_KEY": { name: user, version: "v1" },
    "otel.exporter.otlp-http.headers.x-key": { name: user, version: "v1" },
  },
  layers: [
    { name: { type: "project", dotCodexFolder: "/p/.codex" }, version: "v2", config: { otel: "planted-layer" } },
    { name: user, version: "v1", config: { model_providers: { mock: { env_key: "PLANTED_KEY" } } } },
  ],
}

test("config/read keeps provider names and the rows' keys, and no provider key, MCP environment or otel header", async () => {
  const kept = JSON.stringify(allowedConfig(REPLY))
  for (const value of PLANTED) expect(kept).not.toContain(value)
  expect(allowedConfig(REPLY)).toEqual({
    config: { model_providers: { mock: { name: "Mock" } }, web_search: "live", allow_login_shell: true },
    origins: { web_search: { name: user, version: "v1" } },
    layers: [
      { name: { type: "project", dotCodexFolder: "/p/.codex" }, version: "v2", disabledReason: null },
      { name: user, version: "v1", disabledReason: null },
    ],
  })
  const rows = await createSettings(() => ({ request: () => Promise.resolve(REPLY) }), "/p").rows()
  const shown = JSON.stringify(rows)
  for (const value of PLANTED) expect(shown).not.toContain(value)
  expect(allowedConfig({ config: { model_providers: { bare: { base_url: "http://z" } } } }).config).toEqual({
    model_providers: { bare: {} },
  })
  expect(allowedConfig("nonsense")).toEqual({ config: { model_providers: {} }, origins: {}, layers: null })
})

const row = (rows: SettingRow[], id: string) => {
  const found = rows.find((candidate) => candidate.id === id)
  return found && { value: found.value, origin: found.origin?.layer ?? null, over: found.overriddenBy }
}

test("settings: rows with their origins, writes to config.toml, a conflict read again, rows after", async () => {
  const run = await replayed(settings)
  const reads = run.outputs.flatMap((output) => ("settings" in output ? [output.settings] : []))
  const [before = [], after = []] = reads
  expect(
    ["web-search", "verbosity", "compaction.threshold", "tool-output.tokens", "login-shell"].map((id) => [
      row(before, id),
      row(after, id),
    ]),
  ).toEqual([
    [
      { value: "live", origin: "user", over: null },
      { value: "disabled", origin: "user", over: null },
    ],
    [
      { value: "low", origin: "project", over: "project" },
      { value: "low", origin: "project", over: "project" },
    ],
    [
      { value: 50000, origin: "user", over: null },
      { value: 60000, origin: "user", over: null },
    ],
    [
      { value: null, origin: null, over: null },
      { value: 2000, origin: "user", over: null },
    ],
    [
      { value: "true", origin: null, over: null },
      { value: "false", origin: "user", over: null },
    ],
  ])
  expect(before.every((setting) => setting.writable && setting.applies === "new-session")).toBe(true)
})

test("lists: skills, servers, hooks and files, a skill toggled, and a skill run as a command", async () => {
  const run = await replayed(lists)
  const told = run.events.flatMap((event) => (event.type === "lists" ? [event.lists] : []))
  const greet = told.flatMap((list) => list.skills ?? []).filter((skill) => skill.name === "greet")
  expect(greet.map((skill) => [skill.group, skill.enabled])).toEqual([
    ["project", true],
    ["project", false],
    ["project", true],
    ["project", true],
  ])
  expect(told.find((list) => list.commands)?.commands?.map((command) => command.name)).toContain("greet")
  expect(told.find((list) => list.mcp)?.mcp?.map((server) => [server.name, server.state, server.tools])).toEqual([
    ["echo", "connected", ["echo"]],
    ["remote", "failed", []],
  ])
  expect(told.find((list) => list.hooks)?.hooks).toEqual([{ event: "PreToolUse", matcher: "Bash", plugin: null }])
  expect(run.outputs).toContainEqual({ files: ["src/", "src/a.ts"] })
})
