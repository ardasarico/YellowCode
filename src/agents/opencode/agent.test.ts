import { expect, test } from "bun:test"
import type { StartOptions } from "../../agent/agent.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { opencodeKind, startOpencode, type Deps } from "./agent.ts"
import type { Clock } from "./sse.ts"
import type { Reply, Request, Transport } from "./transport.ts"

const OPTIONS: StartOptions = {
  cwd: "/work",
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
  clientTools: [],
  mcpServers: [],
}

const SESSION = {
  id: "ses_1",
  projectID: "p",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  location: { directory: "/work" },
}

const ANSWERS: Record<string, unknown> = {
  "POST /api/session": { data: SESSION },
  "GET /api/session/ses_1": { data: SESSION },
  "GET /api/session/ses_1/message": { data: [], cursor: {} },
  "GET /api/session/active": { data: {} },
  "GET /api/session/ses_1/permission": { data: [] },
  "GET /api/session/ses_1/form": { data: [] },
  "DELETE /api/session/ses_1": {},
}

// A service whose stream stays connected until `stop`, giving the frames `send` puts on it; after `stop`, nothing
// answers.
function service(): Transport & { asked: string[]; send(...frames: unknown[]): void; stop(): void } {
  const asked: string[] = []
  const stopped = Promise.withResolvers<void>()
  const queued: unknown[] = []
  let wake = Promise.withResolvers<void>()
  let gone = false
  return {
    asked,
    send(...frames) {
      queued.push(...frames)
      wake.resolve()
    },
    stop() {
      gone = true
      stopped.resolve()
    },
    request(req: Request): Promise<Reply> {
      asked.push(`${req.method} ${req.path}`)
      const body = ANSWERS[`${req.method} ${req.path}`]
      if (gone || body === undefined) return Promise.reject(new Error("opencode: it failed to connect"))
      return Promise.resolve({ status: 200, body })
    },
    async *events() {
      if (gone) throw new Error("opencode: the event stream failed to connect")
      yield { id: "evt_1", type: "server.connected", data: {} }
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- waits for the next frames or the end
        await Promise.race([wake.promise, stopped.promise])
        if (gone) return
        wake = Promise.withResolvers<void>()
        yield* queued.splice(0)
      }
    },
    socket: () => Promise.reject(new Error("no socket")),
  }
}

// Time moves only by what the stream waits.
function fakeClock(): Clock {
  let now = 0
  return {
    now: () => now,
    sleep(ms) {
      now += ms
      return Promise.resolve()
    },
  }
}

const deps = (
  transports: Transport[],
  found: Deps["detect"] = () => Promise.resolve({ installed: true, version: "2.2.0", blocked: null, signedIn: null }),
) => {
  const services: string[] = []
  return {
    services,
    deps: {
      detect: found,
      binary: () => "/bin/opencode",
      service(binary: string) {
        services.push(binary)
        return Promise.resolve({ url: "http://127.0.0.1:1" })
      },
      transport: () => {
        const next = transports.shift()
        if (!next) throw new Error("no transport left")
        return next
      },
      clock: fakeClock(),
      appVersion: "0.0.0",
      readFile: () => Promise.resolve(null),
    } satisfies Deps,
  }
}

async function until(events: AsyncIterator<AgentEvent>, type: AgentEvent["type"]): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = []
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- reads in order
    const next = await events.next()
    if (next.done) throw new Error(`the events ended before ${type}`)
    seen.push(next.value)
    if (next.value.type === type) return seen
  }
}

test("lists share one look for a service that cannot start, and do not look again until the next detection", async () => {
  const { deps: base } = deps([])
  const failing = Promise.withResolvers<never>()
  let looks = 0
  const kind = opencodeKind({
    ...base,
    service: () => {
      looks++
      return failing.promise
    },
  })
  const recent = kind.sessions("/work").catch(String)
  const resume = kind.sessions("/work").catch(String)
  await Bun.sleep(0)
  failing.reject(new Error("opencode's service did not start"))
  expect(await Promise.all([recent, resume])).toEqual([
    "Error: opencode's service did not start",
    "Error: opencode's service did not start",
  ])
  await kind.sessions("/work").catch(String)
  expect(looks).toBe(1)
  await kind.detect()
  await kind.sessions("/work").catch(String)
  expect(looks).toBe(2)
})

test("a service that goes away ends the session with a problem, and a restart connects again", async () => {
  const first = service()
  const { deps: running, services } = deps([first, service()])
  const agent = await startOpencode(OPTIONS, running)
  const events = agent.events[Symbol.asyncIterator]()
  first.stop()
  const ended = (await until(events, "ended")).at(-1)
  expect(ended).toMatchObject({ type: "ended", problem: { text: "opencode stopped responding" } })
  expect(first.asked).toContain("GET /api/info")

  expect(await agent.restart({ mode: null, defaultMode: null, thinking: false })).toEqual({ ok: true, note: null })
  const again = (await until(events, "ready")).map((event) => event.type)
  expect(again).toEqual(["starting", "ready"])
  expect(services).toEqual(["/bin/opencode", "/bin/opencode"])
  await agent.close()
})

test("a session deleted in another client is not connected again by a restart", async () => {
  const shared = service()
  const { deps: running, services } = deps([shared, service()])
  const agent = await startOpencode(OPTIONS, running)
  const events = agent.events[Symbol.asyncIterator]()
  shared.send({ id: "evt_2", created: 2, type: "session.deleted", data: { sessionID: "ses_1" } })
  await until(events, "ended")
  expect(await agent.restart({ mode: null, defaultMode: null, thinking: false })).toEqual({
    ok: false,
    problem: "This session was deleted in opencode",
  })
  expect(services).toEqual(["/bin/opencode"])
  await agent.close()
})

test("opencode 1 is refused before any service is looked for", async () => {
  const { deps: old, services } = deps([], () =>
    Promise.resolve({ installed: true, version: "1.4.3", blocked: "needs opencode 2", signedIn: null }),
  )
  const refused = await startOpencode(OPTIONS, old).then(
    () => "",
    (error: unknown) => String(error),
  )
  expect(refused).toContain("needs opencode 2")
  expect(services).toEqual([])
})

test("a missing opencode is refused with a plain reason before any service is looked for", async () => {
  const { deps: missing, services } = deps([], () => Promise.resolve({ installed: false }))
  const refused = await startOpencode(OPTIONS, missing).then(
    () => "",
    (error: unknown) => String(error),
  )
  expect(refused).toBe("Error: opencode is not installed")
  expect(services).toEqual([])
})

const textStarted = (sessionID: string, n: number) => ({
  id: `evt_${n}`,
  created: n,
  type: "session.text.started",
  data: { sessionID, assistantMessageID: `msg_${n}`, ordinal: 0 },
})

test("events of other sessions on the shared service never reach this one", async () => {
  const shared = service()
  const agent = await startOpencode(OPTIONS, deps([shared]).deps)
  const events = agent.events[Symbol.asyncIterator]()
  shared.send(textStarted("ses_other", 2), textStarted("ses_1", 3))
  const seen = await until(events, "text.start")
  expect(seen.map((event) => event.type)).toEqual(["ready", "seen", "turn.open", "reply", "turn.step", "text.start"])
  expect(seen.at(-1)).toMatchObject({ part: "msg_3:text:0" })
  await agent.close()
})

const durable = (frame: object, seq: number) => ({ ...frame, durable: { aggregateID: "ses_1", seq, version: 1 } })

test("a durable event of a type not read keeps the sequence, so only a real gap resyncs", async () => {
  const shared = service()
  const agent = await startOpencode(OPTIONS, deps([shared]).deps)
  const events = agent.events[Symbol.asyncIterator]()
  const unknown = { id: "evt_x", created: 2, type: "session.viewed", data: { sessionID: "ses_1" } }
  shared.send(durable(textStarted("ses_1", 1), 1), durable(unknown, 2), durable(textStarted("ses_1", 3), 3))
  await until(events, "text.start")
  await until(events, "text.start")
  expect(shared.asked).not.toContain("GET /api/session/ses_1/message")
  shared.send(durable(textStarted("ses_1", 5), 5))
  await until(events, "text.start")
  expect(shared.asked).toContain("GET /api/session/ses_1/message")
  await agent.close()
})

test("a session opencode does not keep is deleted on close", async () => {
  const shared = service()
  const agent = await startOpencode({ ...OPTIONS, ephemeral: true }, deps([shared]).deps)
  await agent.close()
  expect(shared.asked).toContain("DELETE /api/session/ses_1")
})
