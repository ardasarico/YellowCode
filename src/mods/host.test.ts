import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModHost } from "./host.ts"
import { readManifest } from "./manifest.ts"
import { linkRuntime } from "./runtime.ts"

const calls: string[] = []
Object.assign(globalThis, { modTestCalls: calls })

function writeMod(folder: string, id: string, api: string, source: string): void {
  mkdirSync(join(folder, id), { recursive: true })
  const manifest = { id, name: id, version: "1.0.0", api, entry: "index.ts" }
  writeFileSync(join(folder, id, "yellowcode-mod.json"), JSON.stringify(manifest))
  writeFileSync(join(folder, id, "index.ts"), source)
}

test("a throwing or incompatible mod is marked and the others still load and dispose", async () => {
  const folder = join(mkdtempSync(join(tmpdir(), "yellowcode-mods-")), "mods")
  mkdirSync(folder, { recursive: true })
  linkRuntime(folder)
  writeMod(
    folder,
    "works",
    "^1.0",
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
    "^1.0",
    `import { defineMod } from "yellowcode/mod"
export default defineMod({ setup() { throw new Error("broken setup") } })`,
  )
  writeMod(folder, "too-new", "^2.0", `export default {}`)

  let disabled: string[] = []
  const host = createModHost({ folder, disabled: () => disabled, saveDisabled: (ids) => (disabled = ids) })
  const failures: string[] = []
  host.onFailure((failure) => failures.push(failure.id))
  host.discover()
  await host.loadAll()

  const status = Object.fromEntries(host.entries.map((entry) => [entry.id, entry.status]))
  expect(status).toEqual({ works: "on", throws: "failed", "too-new": "incompatible" })
  expect(host.entries.find((entry) => entry.id === "too-new")?.problem).toBe("needs mod API ^2.0, this is 1.0.0")
  expect(host.entries.find((entry) => entry.id === "throws")?.error?.message).toBe("Error: broken setup")
  expect(failures.toSorted()).toEqual(["throws", "too-new"])

  await host.setEnabled("works", false)
  expect(calls).toEqual(["first", "cleanup"])
  expect(disabled).toEqual(["works"])
  expect(host.entries.find((entry) => entry.id === "works")?.status).toBe("off")
})

test("turning a mod off while its setup awaits removes what it adds afterwards", async () => {
  const folder = join(mkdtempSync(join(tmpdir(), "yellowcode-mods-")), "mods")
  mkdirSync(folder, { recursive: true })
  linkRuntime(folder)
  writeMod(
    folder,
    "slow",
    "^1.0",
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
  host.discover()
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
    "^1.0",
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
  host.discover()
  await host.loadAll()
  setTick(1)
  await host.setEnabled("effect", false)
  setTick(2)
  expect(calls).toEqual(["tick 0", "tick 1"])
})

test("a manifest with the old yellowcode field says to use api", () => {
  const folder = join(mkdtempSync(join(tmpdir(), "yellowcode-mods-")), "old")
  mkdirSync(folder, { recursive: true })
  const manifest = { id: "old", name: "old", version: "1.0.0", yellowcode: ">=0.0.0", entry: "index.ts" }
  writeFileSync(join(folder, "yellowcode-mod.json"), JSON.stringify(manifest))
  expect(readManifest(folder)).toEqual({
    ok: false,
    problem: 'yellowcode-mod.json: "yellowcode" is now "api", like "api": "^1.0"',
  })
})

test("a setup that never finishes fails after the limit", async () => {
  const folder = join(mkdtempSync(join(tmpdir(), "yellowcode-mods-")), "mods")
  mkdirSync(folder, { recursive: true })
  linkRuntime(folder)
  writeMod(
    folder,
    "hangs",
    "^1.0",
    `import { defineMod } from "yellowcode/mod"
export default defineMod({ setup: () => new Promise(() => {}) })`,
  )
  const host = createModHost({ folder, disabled: () => [], saveDisabled: () => {}, setupLimitMs: 50 })
  host.discover()
  await host.loadAll()
  const entry = host.entries.find((candidate) => candidate.id === "hangs")
  expect(entry?.status).toBe("failed")
  expect(entry?.error?.message).toBe("Error: setup did not finish in 0.05 s")
})
