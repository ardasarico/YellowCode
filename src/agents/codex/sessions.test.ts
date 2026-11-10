import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { replayAgent, type DriverOutput } from "../../../tools/codex/agent-driver.ts"
import { pick } from "../../../tools/codex/driver.ts"
import { connect, fork, sessions } from "../../../tools/codex/scenarios/sessions.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createRegistry } from "../../agent/registry.ts"
import { memoryKind } from "../../session/memory-kind.ts"
import { createSession, loadHistory } from "../../session/session.ts"
import { codexKind } from "./agent.ts"
import { readFixture, type Fixture, type FixtureLine } from "./fixture.ts"
import { replayTransport } from "./replay-transport.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const text = (name: string) => readFileSync(join(ROOT, "fixtures", "codex", `${name}.jsonl`), "utf8")
const fixture = (name: string) => readFixture(text(name))
// Written again only with UPDATE_CODEX_GOLDENS=1; the Claude golden test never reads them.
const GOLDENS = join(ROOT, "fixtures", "goldens", "codex")

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

function golden(name: string, value: unknown): void {
  const got = `${JSON.stringify(value, null, 2)}\n`
  const file = join(GOLDENS, `${name}.json`)
  if (process.env["UPDATE_CODEX_GOLDENS"] === "1") {
    mkdirSync(GOLDENS, { recursive: true })
    writeFileSync(file, got)
  }
  expect(got).toBe(readFileSync(file, "utf8"))
}

const listed = (outputs: DriverOutput[]) => outputs.flatMap((output) => ("sessions" in output ? output.sessions : []))
const pages = (outputs: DriverOutput[]) => outputs.flatMap((output) => ("history" in output ? [output.history] : []))
const prompts = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === "user" && event.prompt ? [event.prompt] : []))

const DETECTED = { installed: true, version: "0.165.0", blocked: null, signedIn: null } as const

// The fixture with the result of `method` on app-server `c` swapped for `answer`.
function answered(base: Fixture, c: number, method: string, answer: Record<string, unknown>): Fixture {
  const out = base.lines.find(
    (line) => line.kind === "out" && (line.c ?? 0) === c && JSON.stringify(line.msg).includes(`"${method}"`),
  )
  const id = out?.kind === "out" ? pick(out.msg, "id") : undefined
  const lines = base.lines.map((line): FixtureLine => {
    if (line.kind !== "in" || (line.c ?? 0) !== c) return line
    const reply = pick(line.msg, "method") === undefined && pick(line.msg, "id") === id
    return reply ? { ...line, msg: { id, ...answer } } : line
  })
  return { ...base, lines }
}

test("the list holds the folder's prompted threads, newest first, and the history reads their turns back", async () => {
  const { outputs, transports } = await replayAgent((driver) => sessions.run(driver), fixture("sessions"))
  expect(transports.map((transport) => transport.unused())).toEqual([[], [], [], [], []])
  // The third thread was never prompted, so Codex leaves it out.
  expect(listed(outputs).map((entry) => [entry.ref.id, entry.title, entry.branch])).toEqual([
    ["00000000-0000-7000-8000-000000000008", "GOLF start over", "main"],
    ["00000000-0000-7000-8000-000000000001", "ECHO one: what is in the readme?", "main"],
  ])
  const [page] = pages(outputs)
  if (!page) throw new Error("the scenario reads the history")
  expect(prompts(page.events)).toEqual(["prompt-1", "prompt-2"])
  const store = createSession()
  loadHistory(store, page.events)
  golden("sessions", { page, state: store.state })
})

test("a copy before a prompt leaves that turn and later ones out, and goes on in a thread of its own", async () => {
  const { outputs, transports } = await replayAgent((driver) => fork.run(driver), fixture("fork"))
  expect(transports.map((transport) => transport.unused().length)).toEqual([0, 0, 0, 0, 0, 0])
  const [copy] = pages(outputs)
  expect(prompts(copy?.events ?? [])).toEqual(["prompt-1", "prompt-4"])
  expect(listed(outputs).map((entry) => entry.title)).toEqual(["FOXTROT four", "FOXTROT one"])
})

test("/resume merges Codex threads with another agent's sessions, newest first", async () => {
  const codex = codexKind({
    detect: () => Promise.resolve(DETECTED),
    // The list's own app-server, the fourth the scenario spawned.
    spawn: () => replayTransport(fixture("sessions"), 3),
    appVersion: "0.0.0-recording",
  })
  const other = {
    ...memoryKind("other", "Other").kind,
    sessions: () =>
      Promise.resolve([
        {
          ref: { agent: "other", id: "o1" },
          title: "newer",
          firstPrompt: "newer",
          cwd: "<root>/project",
          branch: null,
          model: null,
          modified: 2_000_000_000_000,
        },
        {
          ref: { agent: "other", id: "o2" },
          title: "older",
          firstPrompt: "older",
          cwd: "<root>/project",
          branch: null,
          model: null,
          modified: 1,
        },
      ]),
  }
  const merged = await createRegistry([other, codex]).sessions("<root>/project")
  expect(merged.map((entry) => `${entry.ref.agent} ${entry.title}`)).toEqual([
    "other newer",
    "codex GOLF start over",
    "codex ECHO one: what is in the readme?",
    "other older",
  ])
})

const START = {
  cwd: "<root>/project",
  resume: null,
  mode: null,
  defaultMode: null,
  model: null,
  effort: null,
  extraEffort: false,
  ephemeral: false,
  plain: false,
  thinking: false,
  instructions: [],
  skills: [],
  clientTools: [],
  mcpServers: [],
}

test("nobody signed in: start stops after the account read with the sign-in problem, and nothing logs in", async () => {
  const signedOut = answered(fixture("connect"), 0, "account/read", {
    result: { account: null, requiresOpenaiAuth: true },
  })
  const transport = replayTransport(signedOut)
  const kind = codexKind({
    detect: () => Promise.resolve(DETECTED),
    spawn: () => transport,
    appVersion: "0.0.0-recording",
  })
  const problem = await kind.start(START).then(
    () => null,
    (error: unknown) => String(error),
  )
  expect(problem).toBe("Error: Sign in with `codex login`")
  const unused = new Set(transport.unused())
  const sent = signedOut.lines.flatMap((line) =>
    line.kind === "out" && (line.c ?? 0) === 0 && !unused.has(line) ? [pick(line.msg, "method")] : [],
  )
  expect(sent).toEqual(["initialize", "initialized", "account/read"])
})

const sent = z.looseObject({ method: z.string().optional(), params: z.looseObject({}).optional() })

test("a session Codex does not keep starts an ephemeral thread, a plain one with plugins, hooks and apps off", async () => {
  const replay = replayTransport(fixture("connect"))
  let started: unknown = null
  const kind = codexKind({
    detect: () => Promise.resolve(DETECTED),
    spawn: () => ({
      ...replay,
      send(message) {
        const request = sent.parse(message)
        if (request.method !== "thread/start") return replay.send(message)
        const { ephemeral, config, ...params } = request.params ?? {}
        started = { ephemeral, config }
        replay.send({ ...request, params })
      },
    }),
    appVersion: "0.0.0-recording",
  })
  const agent = await kind.start({ ...START, ephemeral: true, plain: true })
  await agent.close()
  expect(started).toEqual({
    ephemeral: true,
    config: { "features.plugins": false, "features.hooks": false, "features.apps": false },
  })
})

test("a thread another app-server writes is refused at resume with a plain problem", async () => {
  const held = answered(fixture("fork"), 1, "thread/resume", {
    error: { code: -32600, message: "thread 00000000-0000-7000-8000-000000000001 already has an active writer" },
  })
  const problem = await replayAgent(async (driver) => {
    await driver.start()
    await driver.start({ ref: { agent: "codex", id: "00000000-0000-7000-8000-000000000001" }, fork: false, at: null })
  }, held).then(
    () => null,
    (error: unknown) => String(error),
  )
  expect(problem).toBe("Error: Codex has this session open in another program")
})

test("a killed app-server ends the session, and a restart goes on with the same thread", async () => {
  const store = createSession({ starting: true })
  const { events, transports } = await replayAgent((driver) => connect.run(driver), fixture("connect"), { store })
  expect(transports.map((transport) => transport.unused())).toEqual([[], []])
  const lifecycle = events.flatMap((event) =>
    event.type === "ended"
      ? [`ended ${event.problem?.text ?? "by us"}`]
      : event.type === "starting"
        ? ["starting"]
        : [],
  )
  expect(lifecycle).toEqual(["ended Codex stopped responding", "starting", "ended by us"])
  expect(events.some((event) => event.type === "unreadable")).toBe(false)
  golden("connect", store.state)
})

test("the adapter never names a sign-in, sign-out, token or feedback method", () => {
  const dir = import.meta.dir
  const sources = [
    ...readdirSync(dir).map((name) => join(dir, name)),
    ...readdirSync(join(dir, "wire")).map((name) => join(dir, "wire", name)),
  ].filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  const named = sources.filter((file) =>
    /account\/login|account\/logout|getAuthStatus|gatewayOAuth|chatgptAuthTokens|feedback\//.test(
      readFileSync(file, "utf8"),
    ),
  )
  expect(named).toEqual([])
})
