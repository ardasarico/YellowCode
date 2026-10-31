import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModHost, type ModAgent, revokedReason } from "./host.ts"
import { readManifest } from "./manifest.ts"
import { linkRuntime } from "./runtime.ts"

const calls: string[] = []
Object.assign(globalThis, { modTestCalls: calls })

const claude: ModAgent = { id: "claude", name: "Claude Code", caps: { clientTools: "live", mcpServers: "live" } }

// `agents` null leaves the field out.
function writeMod(folder: string, id: string, api: string, source: string, agents: unknown = "any"): void {
  mkdirSync(join(folder, id), { recursive: true })
  const manifest = { id, name: id, version: "1.0.0", api, ...(agents === null ? {} : { agents }), entry: "index.ts" }
  writeFileSync(join(folder, id, "yellowcode-mod.json"), JSON.stringify(manifest))
  writeFileSync(join(folder, id, "index.ts"), source)
}

test("a throwing, incompatible or other agent's mod is marked and the others still load and dispose", async () => {
  const folder = join(mkdtempSync(join(tmpdir(), "yellowcode-mods-")), "mods")
  mkdirSync(folder, { recursive: true })
  linkRuntime(folder)
  writeMod(
    folder,
    "works",
    "^0.2",
    `import { defineMod } from "yellowcode/mod"
const calls = (globalThis as any).modTestCalls
export default defineMod({
  setup(mod) {
    mod.onDispose(() => calls.push("first"))
    mod.onDispose(() => { throw new Error("dispose") })
    return () => calls.push("cleanup")
  },
})`,
  )
  writeMod(
    folder,
    "throws",
    "^0.2",
    `import { defineMod } from "yellowcode/mod"
export default defineMod({ setup() { throw new Error("broken setup") } })`,
  )
  const setupRan = `import { defineMod } from "yellowcode/mod"
const calls = (globalThis as any).modTestCalls
export default defineMod({ setup() { calls.push("should not run") } })`
  writeMod(folder, "too-new", "^0.3", setupRan)
  writeMod(folder, "too-old", "^0.1", setupRan)
  writeMod(folder, "pulled", "^0.2", setupRan)
  writeMod(folder, "unlisted-agents", "^0.2", setupRan, null)
  writeMod(folder, "other-agent", "^0.2", setupRan, ["codex"])

  let disabled: string[] = []
  const host = createModHost({
    folder,
    disabled: () => disabled,
    saveDisabled: (ids) => (disabled = ids),
    revoked: (id) => (id === "pulled" ? "steals tokens" : null),
  })
  const failures: string[] = []
  host.onFailure((failure) => failures.push(failure.id))
  host.discover(claude)
  await host.loadAll()

  const status = Object.fromEntries(host.entries.map((entry) => [entry.id, entry.status]))
  expect(status).toEqual({
    works: "on",
    throws: "failed",
    "too-new": "incompatible",
    "too-old": "incompatible",
    pulled: "revoked",
    "unlisted-agents": "failed",
    "other-agent": "elsewhere",
  })
  expect(host.entries.find((entry) => entry.id === "unlisted-agents")?.problem).toBe(
    'yellowcode-mod.json: needs an "agents" list, like "agents": ["claude"], or "any"',
  )
  expect(host.entries.find((entry) => entry.id === "other-agent")?.problem).toBe("not for this agent")
  expect(host.entries.find((entry) => entry.id === "too-new")?.problem).toBe(
    "needs a newer YellowCode · update YellowCode",
  )
  expect(host.entries.find((entry) => entry.id === "too-old")?.problem).toBe("needs a newer version of this mod")
  expect(host.entries.find((entry) => entry.id === "pulled")?.problem).toBe("Revoked: steals tokens")
  expect(host.entries.find((entry) => entry.id === "throws")?.error?.message).toBe("Error: broken setup")
  expect(failures.toSorted()).toEqual(["pulled", "throws", "too-new", "too-old", "unlisted-agents"])
  expect(calls).not.toContain("should not run")

  await host.setEnabled("works", false)
  expect(calls).toEqual(["first", "cleanup"])
  expect(disabled).toEqual(["works"])
  expect(host.entries.find((entry) => entry.id === "works")?.status).toBe("off")
})

test("a revoke matches listed mods by version, unlisted by SHA and local ones only for every version", () => {
  const manifest = {
    id: "x",
    name: "x",
    description: "",
    version: "1.0.0",
    api: "^0.2",
    agents: "any" as const,
    entry: "index.ts",
  }
  const sha = "a".repeat(40)
  const record = { source: "github:o/x", sha, treeHash: "", version: "1.0.0", installedAt: "" }
  const listed = { ...record, listed: true }
  const unlisted = { ...record, listed: false }
  const byVersion = [{ id: "x", versions: ["1.0.0"], reason: "bad" }]
  const bySha = [{ id: "x", versions: [], shas: [sha], reason: "bad" }]
  const all = [{ id: "x", versions: "all" as const, reason: "bad" }]

  expect(revokedReason(byVersion, "x", manifest, listed)).toBe("bad")
  expect(revokedReason(byVersion, "x", { ...manifest, version: "1.0.1" }, listed)).toBeNull()
  expect(revokedReason(byVersion, "x", manifest, unlisted)).toBeNull()
  expect(revokedReason(bySha, "x", manifest, unlisted)).toBe("bad")
  expect(revokedReason(byVersion, "x", manifest, null)).toBeNull()
  expect(revokedReason(all, "x", manifest, null)).toBe("bad")
  expect(revokedReason(all, "y", manifest, null)).toBeNull()
})

test("turning a mod off while its setup awaits removes what it adds afterwards", async () => {
  const folder = join(mkdtempSync(join(tmpdir(), "yellowcode-mods-")), "mods")
  mkdirSync(folder, { recursive: true })
  linkRuntime(folder)
  writeMod(
    folder,
    "slow",
    "^0.2",
    `import { defineMod } from "yellowcode/mod"
const calls = (globalThis as any).modTestCalls
export default defineMod({
  async setup(mod) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    mod.onDispose(() => calls.push("late dispose"))
    return () => calls.push("late cleanup")
  },
})`,
  )
  calls.length = 0
  let disabled: string[] = []
  const host = createModHost({ folder, disabled: () => disabled, saveDisabled: (ids) => (disabled = ids) })
  host.discover(claude)
  const loading = host.loadAll()
  await new Promise((resolve) => setTimeout(resolve, 5))
  await host.setEnabled("slow", false)
  await loading
  expect(calls).toEqual(["late dispose", "late cleanup"])
  expect(host.entries.find((entry) => entry.id === "slow")?.status).toBe("off")
})

test("an effect a mod makes in setup stops when the mod is turned off", async () => {
  const folder = join(mkdtempSync(join(tmpdir(), "yellowcode-mods-")), "mods")
  mkdirSync(folder, { recursive: true })
  linkRuntime(folder)
  const [tick, setTick] = createSignal(0)
  Object.assign(globalThis, { modTestTick: tick })
  writeMod(
    folder,
    "effect",
    "^0.2",
    `import { createEffect } from "solid-js"
import { defineMod } from "yellowcode/mod"
const calls = (globalThis as any).modTestCalls
const tick = (globalThis as any).modTestTick
export default defineMod({
  setup() {
    createEffect(() => calls.push(\`tick \${tick()}\`))
  },
})`,
  )
  calls.length = 0
  let disabled: string[] = []
  const host = createModHost({ folder, disabled: () => disabled, saveDisabled: (ids) => (disabled = ids) })
  host.discover(claude)
  await host.loadAll()
  setTick(1)
  await host.setEnabled("effect", false)
  setTick(2)
  expect(calls).toEqual(["tick 0", "tick 1"])
})

// A mod that adds the tool `name`, whose run fails when the input says so.
const withTool = (name: string) => `import { defineMod } from "yellowcode/mod"
const calls = (globalThis as any).modTestCalls
export default defineMod({
  setup(mod) {
    calls.push("setup ${name}")
    mod.tools.add({
      name: "${name}",
      description: "A tool",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      run: (input) => { if (input.fail) throw new Error("no luck"); return { text: "ran ${name}" } },
    })
    return () => calls.push("cleanup ${name}")
  },
})`

test("another agent loads the mods again: a mod for Claude only is elsewhere there, and only the others' tools are left", async () => {
  const folder = join(mkdtempSync(join(tmpdir(), "yellowcode-mods-")), "mods")
  mkdirSync(folder, { recursive: true })
  linkRuntime(folder)
  writeMod(folder, "anywhere", "^0.2", withTool("any_tool"))
  writeMod(folder, "claude-only", "^0.2", withTool("claude_tool"), ["claude"])
  calls.length = 0
  const host = createModHost({ folder, disabled: () => [], saveDisabled: () => {} })
  host.discover(claude)
  await host.loadAll()
  expect(host.clientTools().map((tool) => [tool.server, tool.name])).toEqual([
    ["mod-anywhere", "any_tool"],
    ["mod-claude-only", "claude_tool"],
  ])

  host.discover({ id: "second", name: "Second", caps: { clientTools: "live", mcpServers: "none" } })
  await host.loadAll()
  const status = Object.fromEntries(host.entries.map((entry) => [entry.id, entry.status]))
  expect(status).toEqual({ anywhere: "on", "claude-only": "elsewhere" })
  expect(calls).toEqual([
    "setup any_tool",
    "setup claude_tool",
    "cleanup any_tool",
    "cleanup claude_tool",
    "setup any_tool",
  ])
  const [tool, ...others] = host.clientTools()
  expect(others).toEqual([])
  expect(tool?.annotations).toEqual({ readOnly: true, destructive: undefined, title: undefined })
  expect(await tool?.run({})).toEqual({ text: "ran any_tool", error: false })
  expect(await tool?.run({ fail: true })).toEqual({ text: "no luck", error: true })
  host.unloadAll()
})

test("manifest servers become launches, other fields fail the manifest, and an agent without servers does not load the mod", async () => {
  const folder = join(mkdtempSync(join(tmpdir(), "yellowcode-mods-")), "mods")
  mkdirSync(folder, { recursive: true })
  linkRuntime(folder)
  writeMod(
    folder,
    "served",
    "^0.2",
    `import { defineMod } from "yellowcode/mod"\nexport default defineMod({ setup() {} })`,
  )
  const mcpServers = {
    local: { command: "node", args: ["${modDir}/s.js"], env: { A: "b" } },
    remote: { type: "http", url: "https://example.test/mcp", headers: { X: "y" } },
  }
  const manifest = { id: "served", name: "served", version: "1.0.0", api: "^0.2", agents: "any", entry: "index.ts" }
  const write = (servers: unknown) =>
    writeFileSync(join(folder, "served", "yellowcode-mod.json"), JSON.stringify({ ...manifest, mcpServers: servers }))
  write(mcpServers)
  const host = createModHost({ folder, disabled: () => [], saveDisabled: () => {} })
  host.discover({ id: "second", name: "Second", caps: { clientTools: "start", mcpServers: "start" } })
  await host.loadAll()
  expect(host.launches()).toEqual([
    { name: "mod-served--local", command: "node", args: [`${join(folder, "served")}/s.js`], env: { A: "b" } },
    { name: "mod-served--remote", url: "https://example.test/mcp", headers: { X: "y" } },
  ])
  host.discover({ id: "third", name: "Third", caps: { clientTools: "start", mcpServers: "none" } })
  await host.loadAll()
  expect(host.entries[0]).toMatchObject({ status: "elsewhere", problem: "Third takes no MCP servers from mods" })
  expect(host.launches()).toEqual([])
  write({ ...mcpServers, local: { ...mcpServers.local, cwd: "/elsewhere" } })
  expect(readManifest(join(folder, "served"))).toEqual({
    ok: false,
    problem:
      'yellowcode-mod.json: mcpServers.local takes command, args and env, or type "http" or "sse" with url and headers',
  })
  host.unloadAll()
})

test("a manifest with the old yellowcode field says to use api", () => {
  const folder = join(mkdtempSync(join(tmpdir(), "yellowcode-mods-")), "old")
  mkdirSync(folder, { recursive: true })
  const manifest = { id: "old", name: "old", version: "1.0.0", yellowcode: ">=0.0.0", entry: "index.ts" }
  writeFileSync(join(folder, "yellowcode-mod.json"), JSON.stringify(manifest))
  expect(readManifest(folder)).toEqual({
    ok: false,
    problem: 'yellowcode-mod.json: "yellowcode" is now "api", like "api": "^0.2"',
  })
})

test("a setup that never finishes fails after the limit", async () => {
  const folder = join(mkdtempSync(join(tmpdir(), "yellowcode-mods-")), "mods")
  mkdirSync(folder, { recursive: true })
  linkRuntime(folder)
  writeMod(
    folder,
    "hangs",
    "^0.2",
    `import { defineMod } from "yellowcode/mod"
export default defineMod({ setup: () => new Promise(() => {}) })`,
  )
  const host = createModHost({ folder, disabled: () => [], saveDisabled: () => {}, setupLimitMs: 50 })
  host.discover(claude)
  await host.loadAll()
  const entry = host.entries.find((candidate) => candidate.id === "hangs")
  expect(entry?.status).toBe("failed")
  expect(entry?.error?.message).toBe("Error: setup did not finish in 0.05 s")
})
