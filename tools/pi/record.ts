// Records pi scenarios against an isolated `pi --mode rpc` and the mock into fixtures/pi/<name>.jsonl.
// Usage: bun tools/pi/record.ts [scenario...] [--check] [--keep]
// --check records to a temp file and compares its masked messages with the committed fixture's.
/* oxlint-disable no-await-in-loop */
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, hostname, userInfo } from "node:os"
import { dirname, join } from "node:path"
import type { Transport } from "../../src/agents/codex/transport.ts"
import { secretsIn } from "../../src/agents/codex/fixture.ts"
import { readFixture } from "../../src/agents/pi/fixture.ts"
import { startBlocker } from "../codex/server.ts"
import { createScrubber } from "../codex/scrub.ts"
import { createDriver } from "./driver.ts"
import { makeRoot, writeModels } from "./env.ts"
import { startMock } from "./mock.ts"
import type { Scenario } from "./scenario.ts"
import { scenarios } from "./scenarios/index.ts"
import { startPi } from "./server.ts"
import { TMP } from "../tmp.ts"

const OUT = join(import.meta.dir, "..", "..", "fixtures", "pi")
const QUIET_MS = 750
const SETTLE_MS = 10_000

// Keeps one line per message each way.
function createTap(lines: unknown[]) {
  const started = Date.now()
  let last = Date.now()
  let closing = false
  const t = () => Date.now() - started

  function wrap(inner: Transport): Transport {
    let sent = 0
    async function* messages(): AsyncIterable<unknown> {
      for await (const msg of inner.messages) {
        last = Date.now()
        lines.push({ kind: "in", t: t(), after: sent, msg })
        yield msg
      }
    }
    void inner.exited.then((exit) => {
      if (!closing) lines.push({ kind: "exit", t: t(), after: sent, ...exit })
    })
    return {
      messages: messages(),
      send(message) {
        lines.push({ kind: "out", n: sent, t: t(), msg: message })
        sent += 1
        inner.send(message)
      },
      exited: inner.exited,
      close: () => inner.close(),
    }
  }

  return { wrap, last: () => last, closing: () => (closing = true) }
}

const piVersion = () => spawnSync("pi", ["--version"], { encoding: "utf8" }).stdout.trim() || "unknown"

async function record(scenario: Scenario, file: string, keep: boolean): Promise<void> {
  const root = await makeRoot(scenario.name, scenario.files)
  const mock = startMock(scenario.script, join(root.root, "bodies.jsonl"))
  const blocker = startBlocker(join(root.root, "outbound.log"))
  await writeModels(root, mock.baseURL)
  for (const [path, content] of Object.entries(scenario.agent ?? {})) {
    await mkdir(dirname(join(root.agent, path)), { recursive: true })
    await writeFile(join(root.agent, path), content)
  }
  // Discovery stays inside the root; a scenario that needs an extension adds it with `agent` and `args`.
  const pi = startPi(root, blocker.url, ["--no-context-files", ...(scenario.args ?? [])], { keep: true })
  const lines: unknown[] = []
  const problems: string[] = []
  try {
    const tap = createTap(lines)
    let n = 0
    const onIntent = (intent: string, args: unknown) => lines.push({ kind: "intent", n: n++, intent, args })
    const d = createDriver(tap.wrap(pi.transport), { directory: root.project, live: true, onIntent, timeoutMs: 30_000 })
    await scenario.steps(d)
    const until = Date.now() + SETTLE_MS
    while (Date.now() - tap.last() < QUIET_MS && Date.now() < until) await Bun.sleep(100)
    tap.closing()
    await scenario.verify?.(root)
    const outbound = await readFile(join(root.root, "outbound.log"), "utf8").catch(() => "")
    if (outbound !== "") console.log(`${scenario.name}: blocked outbound requests:\n${outbound.trimEnd()}`)
  } finally {
    problems.push(...(await pi.stop()))
    if (!keep) await rm(root.root, { recursive: true, force: true })
    blocker.stop()
    await mock.stop()
  }
  if (problems.length > 0) throw new Error(`${scenario.name}: isolation: ${problems.join("; ")}`)

  const meta = { kind: "meta", scenario: scenario.name, pi: piVersion(), root: "<root>" }
  const scrub = createScrubber({
    root: root.root,
    home: homedir(),
    user: userInfo().username,
    host: hostname(),
    ports: [[mock.port, "mock"]],
  })
  const text = [meta, ...lines].map(scrub).join("\n") + "\n"
  const leaks = secretsIn(text, [homedir(), userInfo().username])
  if (leaks.length > 0) throw new Error(`${scenario.name}: not written, it holds ${[...new Set(leaks)].join(", ")}`)
  readFixture(text)
  await writeFile(file, text)
}

// Times, durations, session file names (they hold the start time) and pi's random 8-hex entry ids differ on every
// run.
const MASKED_KEY = /^(t|timestamp|sessionFile|durationMs)$|At$|Ms$/
const ENTRY_ID = /^[0-9a-f]{8}$/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const mask = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(mask)
  if (typeof value === "string") return ENTRY_ID.test(value) ? "<entry>" : value
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, inner]) => [key, MASKED_KEY.test(key) ? "*" : mask(inner)]),
  )
}

// Our messages, then pi's, each in the order they came: how they fall between each other is up to timing.
function normalized(text: string): string[] {
  const lines = readFixture(text).lines.flatMap((line) => (line.kind === "out" || line.kind === "in" ? [line] : []))
  return lines
    .toSorted((a, b) => (a.kind === b.kind ? 0 : a.kind === "out" ? -1 : 1))
    .map((line) => JSON.stringify(mask({ kind: line.kind, msg: line.msg })))
}

const shown = (line: string | undefined) => line?.slice(0, 600)

function same(name: string, want: string[], got: string[]): boolean {
  const at = want.findIndex((line, index) => line !== got[index])
  if (at < 0 && want.length === got.length) {
    console.log(`${name}: same ${got.length} messages`)
    return true
  }
  const index = at < 0 ? Math.min(want.length, got.length) : at
  console.log(`${name}: messages differ at ${index}\n  want ${shown(want[index])}\n  got  ${shown(got[index])}`)
  return false
}

async function check(scenario: Scenario, keep: boolean): Promise<boolean> {
  const dir = await mkdtemp(`${TMP}/yc-pi-check-`)
  const fresh = join(dir, `${scenario.name}.jsonl`)
  try {
    await record(scenario, fresh, keep)
    const committed = await readFile(join(OUT, `${scenario.name}.jsonl`), "utf8")
    return same(scenario.name, normalized(committed), normalized(await readFile(fresh, "utf8")))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const names = args.filter((arg) => !arg.startsWith("--"))
  const chosen = names.length === 0 ? scenarios : scenarios.filter((scenario) => names.includes(scenario.name))
  const unknown = names.filter((name) => !scenarios.some((scenario) => scenario.name === name))
  if (unknown.length > 0) throw new Error(`unknown scenario: ${unknown.join(", ")}`)
  const keep = args.includes("--keep")
  await mkdir(OUT, { recursive: true })
  let failed = false
  for (const scenario of chosen) {
    if (args.includes("--check")) failed = !(await check(scenario, keep)) || failed
    else {
      await record(scenario, join(OUT, `${scenario.name}.jsonl`), keep)
      console.log(`${scenario.name}: recorded`)
    }
  }
  if (failed) process.exit(1)
}
