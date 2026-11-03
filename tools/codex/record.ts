// Records Codex scenarios against an isolated app-server and the mock into fixtures/codex/<name>.jsonl.
// Usage: bun tools/codex/record.ts [scenario...] [--check] [--keep]
// --check records to a temp file and compares its masked messages with the committed fixture's.
// Scenarios run one at a time on purpose; each owns an app-server.
/* oxlint-disable no-await-in-loop */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, hostname, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { allowedConfig } from "../../src/agents/codex/allow.ts"
import { readFixture, secretsIn } from "../../src/agents/codex/fixture.ts"
import type { Transport } from "../../src/agents/codex/transport.ts"
import { detect } from "../../src/agents/codex/detect.ts"
import { createAgentDriver, type Spawned } from "./agent-driver.ts"
import { createDriver, pick } from "./driver.ts"
import { makeRoot, writeConfig } from "./env.ts"
import { startMock } from "./mock.ts"
import { isRaw, type Scenario } from "./scenario.ts"
import { scenarios } from "./scenarios/index.ts"
import { createScrubber } from "./scrub.ts"
import { startBlocker, startServer, type Running } from "./server.ts"
import { TMP } from "../tmp.ts"

const OUT = join(import.meta.dir, "..", "..", "fixtures", "codex")
const QUIET_MS = 750
const SETTLE_MS = 10_000

// Never sent by a recording: sign-in, credentials and feedback.
const REFUSED = [
  /^account\/login\//,
  /^account\/logout$/,
  /^getAuthStatus$/,
  /^account\/gatewayOAuth\//,
  /^account\/chatgptAuthTokens\//,
  /^feedback\//,
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// account/read keeps only whether someone is signed in, and how.
function accountOnly(result: unknown): unknown {
  const account = pick(result, "account")
  return {
    account: isRecord(account) ? { type: pick(account, "type") } : null,
    requiresOpenaiAuth: pick(result, "requiresOpenaiAuth"),
  }
}

// Wraps each app-server's transport and keeps one line per message each way, numbered by app-server (`c`, left out
// for the first). `remoteControl/*` notifications carry the machine's address and are dropped unrecorded.
function createTap(lines: unknown[]) {
  const started = Date.now()
  let last = Date.now()
  let closing = false
  let count = 0
  const t = () => Date.now() - started

  function wrap(inner: Transport): Transport {
    const c = count++
    const own = c === 0 ? {} : { c }
    let sent = 0
    let closed = false
    // Replies kept as the adapter keeps them.
    const kept = new Map<unknown, (result: unknown) => unknown>()
    async function* messages(): AsyncIterable<unknown> {
      for await (const raw of inner.messages) {
        last = Date.now()
        const method = pick(raw, "method")
        if (typeof method === "string" && method.startsWith("remoteControl/")) continue
        const id = pick(raw, "id")
        const keep = method === undefined ? kept.get(id) : undefined
        const msg = keep && isRecord(raw) && "result" in raw ? { ...raw, result: keep(raw["result"]) } : raw
        lines.push({ kind: "in", ...own, t: t(), after: sent, msg })
        yield msg
      }
    }
    void inner.exited.then((exit) => {
      if (!closing && !closed) lines.push({ kind: "exit", ...own, t: t(), after: sent, ...exit })
    })
    return {
      messages: messages(),
      send(message) {
        const method = pick(message, "method")
        if (typeof method === "string" && REFUSED.some((refused) => refused.test(method)))
          throw new Error(`the recorder does not send ${method}`)
        if (method === "account/read") kept.set(pick(message, "id"), accountOnly)
        if (method === "config/read") kept.set(pick(message, "id"), allowedConfig)
        lines.push({ kind: "out", ...own, n: sent, t: t(), msg: message })
        sent += 1
        inner.send(message)
      },
      exited: inner.exited,
      close() {
        closed = true
        return inner.close()
      },
    }
  }

  return { wrap, last: () => last, closing: () => (closing = true) }
}

const versionOf = (lines: unknown[]) => {
  for (const line of lines) {
    const agent = pick(line, "msg", "result", "userAgent")
    if (typeof agent === "string") return /\/(\d+\.\d+\.\d+\S*)/.exec(agent)?.[1] ?? "unknown"
  }
  return "unknown"
}

async function record(scenario: Scenario, file: string, keep: boolean): Promise<void> {
  const root = await makeRoot(scenario.name, scenario.files)
  const mock = startMock(scenario.script, join(root.root, "bodies.jsonl"))
  const blocker = startBlocker(join(root.root, "outbound.log"))
  const config = typeof scenario.config === "function" ? scenario.config(root) : scenario.config
  await writeConfig(root, mock.baseURL, config, scenario.retries, scenario.top)
  for (const [path, content] of Object.entries(scenario.home ?? {})) {
    await mkdir(dirname(join(root.codex, path)), { recursive: true })
    await writeFile(join(root.codex, path), content)
  }
  const servers: Running[] = []
  const lines: unknown[] = []
  const problems: string[] = []
  try {
    const tap = createTap(lines)
    // Every app-server shares the root, which goes once the last is stopped.
    const spawn = (): Spawned => {
      const server = startServer(root, blocker.url, { keep: true })
      servers.push(server)
      return { ...tap.wrap(server.transport), kill: () => process.kill(server.pid, "SIGKILL") }
    }
    let n = 0
    const onIntent = (intent: string, args: unknown) => lines.push({ kind: "intent", n: n++, intent, args })
    if (isRaw(scenario)) await scenario.steps(createDriver(spawn(), { directory: root.project, live: true, onIntent }))
    else
      await scenario.run(
        createAgentDriver({ directory: root.project, spawn, detect: () => detect(), onIntent, timeoutMs: 30_000 }),
      )
    const until = Date.now() + SETTLE_MS
    while (Date.now() - tap.last() < QUIET_MS && Date.now() < until) await Bun.sleep(100)
    tap.closing()
    await scenario.verify?.(root)
    const outbound = await readFile(join(root.root, "outbound.log"), "utf8").catch(() => "")
    if (outbound !== "") console.log(`${scenario.name}: blocked outbound requests:\n${outbound.trimEnd()}`)
  } finally {
    for (const server of servers) problems.push(...(await server.stop()))
    if (!keep) await rm(root.root, { recursive: true, force: true })
    blocker.stop()
    await mock.stop()
  }
  if (problems.length > 0) throw new Error(`${scenario.name}: isolation: ${problems.join("; ")}`)

  const meta = { kind: "meta", scenario: scenario.name, codex: versionOf(lines), root: "<root>" }
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

// Times, pids, the rollout path (it names the start time), the list's backwards cursor (a time) and config.toml's
// versions (its hash, which holds the mock's port) differ on every run.
// Keys are sorted, as Codex orders some maps (read states by thread) as they happen to come.
const MASKED_KEY = /^(t|path|processId|backwardsCursor|version|expectedVersion)$|At$|AtMs$|Ms$/
const MASKED_ID = /\b00000000-0000-7000-8000-\d{12}\b/g

const mask = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(mask)
  if (typeof value === "string") return value.replace(MASKED_ID, "<id>")
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, inner]) => [key, MASKED_KEY.test(key) ? "*" : mask(inner)]),
  )
}

// An MCP server says it is up whenever its process is, which races the turn and the other servers; a thread's status
// comes from a task of its own, which races the items. Both go after the other notifications, in the order they came.
const RACING = ["thread/status/changed", "mcpServer/startupStatus/updated"]
const startup = (line: { msg: unknown }) => RACING.indexOf(String(pick(line.msg, "method"))) + 1
const server = (line: { msg: unknown }) => (startup(line) === 2 ? String(pick(line.msg, "params", "name")) : "")
// How a server that failed to start says so depends on where its handshake broke.
function settled(msg: unknown): unknown {
  const params = pick(msg, "params")
  if (startup({ msg }) !== 2 || !isRecord(msg) || !isRecord(params) || params["error"] === null) return msg
  return { ...msg, params: { ...params, error: "*" } }
}

// Our requests, then Codex's notifications and requests, then its replies.
const side = (line: { kind: string; msg: unknown }) =>
  line.kind === "out" ? 0 : pick(line.msg, "method") === undefined ? 2 : 1

// Messages each way with ids and times masked, per app-server and direction in the order they came. Codex sends each
// delta it got, so they are compared as they came; how our requests and Codex's replies to them fall between its
// notifications is up to timing, and so is how the threads' notifications (a subagent's and its parent's) interleave.
function normalized(text: string): string[] {
  const lines = readFixture(text).lines.flatMap((line) =>
    line.kind === "out" || line.kind === "in" ? [{ ...line, c: line.c ?? 0 }] : [],
  )
  const threads: string[] = []
  for (const line of lines) {
    const thread = `${line.c}:${String(pick(line.msg, "params", "threadId"))}`
    if (side(line) === 1 && !threads.includes(thread)) threads.push(thread)
  }
  const rank = (line: (typeof lines)[number]) =>
    side(line) === 1 ? threads.indexOf(`${line.c}:${String(pick(line.msg, "params", "threadId"))}`) : 0
  return lines
    .toSorted(
      (a, b) =>
        a.c - b.c ||
        side(a) - side(b) ||
        startup(a) - startup(b) ||
        rank(a) - rank(b) ||
        server(a).localeCompare(server(b)),
    )
    .map((line) => JSON.stringify(mask({ kind: line.kind, c: line.c, msg: settled(line.msg) })))
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
  const dir = await mkdtemp(`${TMP}/yc-cx-check-`)
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
