// Records opencode scenarios against an isolated service and the mock into fixtures/opencode/<name>.jsonl.
// Usage: bun tools/opencode/record.ts [scenario...] [--check] [--keep]
// --check records to a temp file and compares its normalized events, and for adapter scenarios the replayed store
// state, with the committed fixture's.
// Scenarios run one at a time on purpose; each owns a service.
/* oxlint-disable no-await-in-loop */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { allowlistFor } from "../../src/agents/opencode/allow.ts"
import { readFixture, secretsIn } from "../../src/agents/opencode/fixture.ts"
import { discover } from "@opencode/client/service"
import { findService } from "../../src/agents/opencode/service.ts"
import {
  httpTransport,
  type Reply,
  type Request,
  type Socket,
  type Transport,
} from "../../src/agents/opencode/transport.ts"
import { createSession } from "../../src/session/session.ts"
import { createAgentDriver, OWN_VERSION, replayAgent } from "./agent-driver.ts"
import { createDriver, pick } from "./driver.ts"
import { commitSeed, makeRoot, writeConfig, type Root } from "./env.ts"
import { startMock } from "./mock.ts"
import { isRaw, type AgentScenario, type Scenario } from "./scenario.ts"
import { scenarios } from "./scenarios/index.ts"
import { createScrubber } from "./scrub.ts"
import { BINARY, startService } from "./service.ts"
import { TMP } from "../tmp.ts"

const OUT = join(import.meta.dir, "..", "..", "fixtures", "opencode")
const QUIET_MS = 750
const SETTLE_MS = 10_000

// Never called by a recording. One agent's answer carries provider request settings, headers and bodies, and allow.ts
// projects only the list. The client-mcp ticket is for browsers, which cannot send the auth header; the transport
// sends the header, so a ticket never needs to be kept.
const REFUSED = [
  /^\/api\/credential/,
  /^\/api\/integration\/[^/]+\/connect/,
  /^\/api\/agent\/./,
  /^\/api\/experimental\/client-mcp\/token/,
]

const streamOf = (index: number) => (index > 0 ? { stream: index } : {})

// Wraps transports and keeps one line per exchange, event and socket frame. A step is an exchange completed or a
// frame sent; events and frames from opencode note how many steps came before them, and events and exchanges after
// the first event stream which stream was open. A stream its reader closed says so. Request headers are never kept,
// and config, provider, model and agent answers are kept, and handed on, as the adapter's allowlist projection. `cut` ends
// the open event stream, as a broken connection would.
function createTap(lines: unknown[]) {
  const started = Date.now()
  let completed = 0
  let streams = 0
  let last = Date.now()
  let open: AbortController | null = null
  // Sockets opened so far, by name.
  const sockets = new Map<string, number>()
  const t = () => Date.now() - started

  function wrap(inner: Transport): Transport {
    async function request(req: Request): Promise<Reply> {
      if (REFUSED.some((path) => path.test(req.path))) throw new Error(`the recorder does not call ${req.path}`)
      const stream = Math.max(0, streams - 1)
      const raw = await inner.request(req)
      const project = req.method === "GET" ? allowlistFor(req.path) : undefined
      const reply = project ? { status: raw.status, body: project(raw.body, raw.status) } : raw
      const n = completed++
      const { method, path, query = {}, body } = req
      lines.push({
        kind: "http",
        n,
        ...streamOf(stream),
        t: t(),
        method,
        path,
        query,
        body,
        status: reply.status,
        response: reply.body,
      })
      return reply
    }

    async function* events(signal?: AbortSignal): AsyncIterable<unknown> {
      const stream = streams++
      const own = new AbortController()
      open = own
      const close = () => {
        lines.push({ kind: "closed", t: t(), after: completed, stream })
        own.abort()
      }
      signal?.addEventListener("abort", close, { once: true })
      try {
        for await (const event of inner.events(own.signal)) {
          last = Date.now()
          lines.push({ kind: "sse", t: t(), after: completed, ...streamOf(stream), event })
          yield event
        }
      } finally {
        signal?.removeEventListener("abort", close)
      }
    }

    async function socket(name: string): Promise<Socket> {
      const opened = await inner.socket(name)
      const index = sockets.get(name) ?? 0
      sockets.set(name, index + 1)
      const conn = index > 0 ? { conn: index } : {}
      async function* frames(): AsyncIterable<unknown> {
        for await (const frame of opened.frames) {
          last = Date.now()
          lines.push({ kind: "ws", t: t(), after: completed, socket: name, ...conn, dir: "in", frame })
          yield frame
        }
      }
      return {
        frames: frames(),
        send(frame) {
          lines.push({ kind: "ws", t: t(), after: completed, socket: name, ...conn, dir: "out", frame })
          completed += 1
          opened.send(frame)
        },
        close: () => opened.close(),
      }
    }

    return { request, events, socket }
  }

  return { wrap, last: () => last, cut: () => open?.abort() }
}

const fixedDetection = (version: string) => () =>
  Promise.resolve({ installed: true as const, version, blocked: null, signedIn: null })

// The adapter finds the isolated service as it finds the user's: through the registration under XDG_STATE_HOME,
// set for the run only. Detection is fixed, since `opencode --version` would write to the real home, and the
// adapter may not start a service here.
async function runAgent(
  scenario: AgentScenario,
  root: Root,
  tap: ReturnType<typeof createTap>,
  version: string,
  onIntent: (intent: string, args: unknown) => void,
) {
  const saved = process.env["XDG_STATE_HOME"]
  process.env["XDG_STATE_HOME"] = root.state
  const driver = createAgentDriver({
    directory: root.project,
    // Sends and cuts go as the app's do, after what the chat hides.
    store: createSession({ starting: true }),
    onIntent,
    cut: tap.cut,
    live: true,
    deps: {
      detect: fixedDetection(version),
      binary: () => BINARY,
      service: (binary) =>
        findService(binary, {
          discover,
          ensure: () => Promise.reject(new Error("the recorder never starts a service through the adapter")),
        }),
      transport: (endpoint, directory) => tap.wrap(httpTransport(endpoint, directory)),
      appVersion: OWN_VERSION,
    },
  })
  try {
    await scenario.run(driver)
    return driver
  } catch (error) {
    await driver.close()
    throw error
  } finally {
    if (saved === undefined) delete process.env["XDG_STATE_HOME"]
    else process.env["XDG_STATE_HOME"] = saved
  }
}

async function record(scenario: Scenario, file: string, keep: boolean): Promise<void> {
  const root = await makeRoot(scenario.name, scenario.files, scenario.bin, !scenario.lateCommit)
  const mock = startMock(scenario.script, join(root.root, "bodies.jsonl"))
  const { config } = scenario
  await writeConfig(root, mock.baseURL, typeof config === "function" ? config(mock.baseURL, root) : config)
  const service = await startService(root, { keep })
  const lines: unknown[] = []
  const problems: string[] = []
  try {
    if (scenario.lateCommit) {
      await service.transport().request({ method: "GET", path: "/api/location" })
      commitSeed(root.project)
    }
    const info = await service.transport().request({ method: "GET", path: "/api/info" })
    const version = pick(info.body, "version")
    lines.push({ kind: "meta", scenario: scenario.name, opencode: String(version), root: "<root>" })
    const tap = createTap(lines)
    let n = 0
    const onIntent = (intent: string, args: unknown) => lines.push({ kind: "intent", n: n++, intent, args })
    const settle = async () => {
      const until = Date.now() + SETTLE_MS
      while (Date.now() - tap.last() < QUIET_MS && Date.now() < until) await Bun.sleep(100)
    }
    if (isRaw(scenario)) {
      const driver = createDriver(tap.wrap(service.transport()), { directory: root.project, live: true, onIntent })
      await driver.until("server.connected")
      await scenario.steps(driver)
      await settle()
      driver.close()
    } else {
      const driver = await runAgent(scenario, root, tap, String(version), onIntent)
      await settle()
      await driver.close()
    }
    await scenario.verify?.(root)
  } finally {
    problems.push(...(await service.stop()))
    await mock.stop()
  }
  if (problems.length > 0) throw new Error(`${scenario.name}: isolation: ${problems.join("; ")}`)

  const scrub = createScrubber({
    root: root.root,
    home: homedir(),
    host: hostname(),
    ports: [
      [Number(new URL(service.endpoint.url).port), "service"],
      [mock.port, "mock"],
    ],
  })
  const text = lines.map(scrub).join("\n") + "\n"
  const leaks = secretsIn(text, [service.password, homedir()])
  if (leaks.length > 0) throw new Error(`${scenario.name}: not written, it holds ${[...new Set(leaks)].join(", ")}`)
  readFixture(text)
  await writeFile(file, text)
}

const MASKED_KEYS = new Set([
  "created",
  "updated",
  "started",
  "time",
  "start",
  "end",
  "slug",
  "snapshot",
  "at",
  "durationMs",
  "startedAt",
  "endedAt",
  "modified",
])

const mask = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(mask)
  if (typeof value === "string")
    return value.replace(/\b([a-z]{2,6})_\d+(_\d+)?\b/g, "$1_*").replace(/\b[0-9a-f]{40,64}\b/g, "<hash>")
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, MASKED_KEYS.has(key) ? "*" : mask(inner)]),
  )
}

// Event types and data and socket frames, with ids, times and other per-run values masked. The title request's
// usage and rename race the turn they name, and opencode refreshes the project when it likes, so each stream has
// them at its end. opencode merges deltas that arrive close together, so a run of deltas of one part counts as one.
// A Code Mode call's progress races the end of its step's model stream, so the progress goes first.
function normalized(text: string): string[] {
  const streams: { events: Wire[]; title: Wire[] }[] = []
  const frames: string[] = []
  for (const line of readFixture(text).lines) {
    if (line.kind === "ws")
      frames.push(JSON.stringify(mask({ socket: line.socket, conn: line.conn, dir: line.dir, frame: line.frame })))
    if (line.kind !== "sse") continue
    const stream = (streams[line.stream ?? 0] ??= { events: [], title: [] })
    const event = wireOf(line.event)
    const last = stream.events.at(-1)
    if (event.type === "session.renamed" && last?.type === "session.usage.updated")
      stream.title.push(stream.events.pop() ?? last, event)
    else if (event.type === "project.updated") stream.title.push(event)
    else if (last && event.type.endsWith(".delta") && sameDelta(last, event))
      last.data = { ...event.data, delta: `${String(last.data["delta"])}${String(event.data["delta"])}` }
    else if (
      event.type === "session.tool.progress" &&
      last?.type === "session.step.streamed" &&
      last.data["assistantMessageID"] === event.data["assistantMessageID"]
    )
      stream.events.splice(-1, 0, event)
    else stream.events.push(event)
  }
  return [...streams.flatMap((stream) => masked(stream.events.concat(stream.title))), ...frames]
}

type Wire = { type: string; data: Record<string, unknown> }

function wireOf(event: unknown): Wire {
  const data = pick(event, "data")
  const fields = typeof data === "object" && data !== null ? Object.fromEntries(Object.entries(data)) : {}
  return { type: String(pick(event, "type")), data: fields }
}

// Two deltas of the same part, the text aside.
const sameDelta = (a: Wire, b: Wire) =>
  a.type === b.type && JSON.stringify({ ...a.data, delta: null }) === JSON.stringify({ ...b.data, delta: null })

const masked = (events: Wire[]) => events.map((event) => JSON.stringify(mask(event)))

// The store state the adapter's events build when the scenario runs on a replay of `text`, masked like the wire:
// one line per item, then the rest, then what the kind's own reads gave. The events themselves are not compared: how far the first resync's GETs run
// ahead of the stream depends on timing, which moves `seen` events and folds text deltas into a start.
async function neutral(scenario: AgentScenario, text: string): Promise<string[]> {
  const now = Date.now
  Date.now = () => 1_800_000_000_000
  try {
    const store = createSession({ starting: true })
    const { outputs } = await replayAgent((driver) => scenario.run(driver), readFixture(text), { store })
    const { items, byId, ...rest } = store.state
    return [
      ...items.map((id) => JSON.stringify(mask(byId[id]))),
      JSON.stringify(mask(rest)),
      ...outputs.map((output) => JSON.stringify(mask(output))),
    ]
  } finally {
    Date.now = now
  }
}

function same(what: string, name: string, want: string[], got: string[]): boolean {
  const at = want.findIndex((line, index) => line !== got[index])
  if (at < 0 && want.length === got.length) {
    console.log(`${name}: same ${got.length} ${what}`)
    return true
  }
  const index = at < 0 ? Math.min(want.length, got.length) : at
  console.log(`${name}: ${what} differ at item ${index}\n  want ${want[index]}\n  got  ${got[index]}`)
  return false
}

async function check(scenario: Scenario, keep: boolean): Promise<boolean> {
  const dir = await mkdtemp(`${TMP}/yc-oc-check-`)
  const fresh = join(dir, `${scenario.name}.jsonl`)
  try {
    await record(scenario, fresh, keep)
    const committed = await readFile(join(OUT, `${scenario.name}.jsonl`), "utf8")
    const recorded = await readFile(fresh, "utf8")
    const wire = same("events and frames", scenario.name, normalized(committed), normalized(recorded))
    if (isRaw(scenario)) return wire
    const events = same(
      "store items",
      scenario.name,
      await neutral(scenario, committed),
      await neutral(scenario, recorded),
    )
    return wire && events
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
