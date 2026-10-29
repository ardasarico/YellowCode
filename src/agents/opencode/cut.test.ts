import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { unwrap } from "solid-js/store"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { replayAgent } from "../../../tools/opencode/agent-driver.ts"
import type { AgentScenario } from "../../../tools/opencode/scenario.ts"
import { cut, cutElsewhere, KILO_FILES } from "../../../tools/opencode/scenarios/cut.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { Capture } from "../../rewind/live-rewind.ts"
import { createFileRewind } from "../../rewind/rewind-files.ts"
import { openSnapshots } from "../../rewind/snapshots.ts"
import { rewindPoints, type Rewound } from "../../session/rewind.ts"
import { createSession, type SessionStore } from "../../session/session.ts"
import type { Session } from "../../session/types.ts"
import { createCuts } from "./cut.ts"
import { readFixture, type HttpLine } from "./fixture.ts"
import { resync } from "./resync.ts"
import { createTranslator } from "./translate.ts"
import type { Reply, Transport } from "./transport.ts"
import { createEventReader, type OpencodeEvent } from "./wire/events.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const fixture = (name: string) => readFixture(readFileSync(join(ROOT, "fixtures", "opencode", `${name}.jsonl`), "utf8"))
const http = (name: string) =>
  fixture(name)
    .lines.filter((line): line is HttpLine => line.kind === "http")
    .map((line) => `${line.method} ${line.path.replace(/^\/api\/session\/ses_1/, "")}`)

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

const told = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)

const texts = (state: Session) =>
  state.items.flatMap((id) => {
    const item = state.byId[id]
    return item?.kind === "user" ? [item.text] : item?.kind === "text" ? [item.markdown] : []
  })

// The golden is written again only with UPDATE_OPENCODE_GOLDENS=1. `cuts`: the session as each cut or undo left it.
// `timeline`: each prompt as it shows, and each revert request once answered.
async function replayed(scenario: AgentScenario) {
  const store = createSession({ starting: true })
  const cuts: { state: Session; rewound: Rewound | null }[] = []
  const timeline: string[] = []
  const copy = () => structuredClone(unwrap(store.state))
  const watched: SessionStore = {
    ...store,
    rewind(rewound) {
      cuts.push({ state: copy(), rewound })
      store.rewind(rewound)
    },
    showEarly(user) {
      timeline.push(`show ${user.text}`)
      store.showEarly(user)
    },
    event(event) {
      store.event(event)
      if (event.type.startsWith("cut")) cuts.push({ state: copy(), rewound: store.state.rewound })
    },
  }
  const run = await replayAgent((driver) => scenario.run(driver), fixture(scenario.name), {
    store: watched,
    prepare(transport) {
      const request = transport.request.bind(transport)
      transport.request = async (req) => {
        const reply = await request(req)
        if (req.path.includes("/revert")) timeline.push(`${req.method} ${req.path.split("/revert")[1] || "/"}`)
        return reply
      }
    },
  })
  expect(run.transport.unused()).toEqual([])
  const golden = join(ROOT, "fixtures", "goldens", "opencode", `${scenario.name}.json`)
  const events = run.events.filter((event) => event.type !== "seen")
  const got = `${JSON.stringify({ events, outputs: run.outputs, state: store.state }, null, 2)}\n`
  if (process.env["UPDATE_OPENCODE_GOLDENS"] === "1") {
    mkdirSync(join(golden, ".."), { recursive: true })
    writeFileSync(golden, got)
  }
  expect(got).toBe(readFileSync(golden, "utf8"))
  return { events, store, cuts, timeline }
}

test("our cut stages at once, its undo leaves no turn, and the next send commits before the prompt shows", async () => {
  const { events, store, cuts, timeline } = await replayed(cut)
  expect(http("cut").filter((line) => line.includes("/revert") || line.endsWith("/prompt"))).toEqual([
    "POST /prompt",
    "POST /prompt",
    "POST /prompt",
    "POST /revert/stage",
    "DELETE /revert",
    "POST /revert/stage",
    "POST /revert/commit",
    "POST /prompt",
  ])
  // Our own reverts come back as no event, and the undo's empty execution as no turn.
  expect(told(events, "cut")).toEqual([])
  expect(told(events, "cut.undone")).toEqual([])
  expect(told(events, "turn.open")).toHaveLength(4)
  expect(cuts.map((at) => at.rewound?.prompts)).toEqual([2, 2])
  // The prompt shows once the conversation went back.
  expect(timeline).toEqual([
    "show KILO one",
    "show KILO two",
    "show KILO three",
    "POST /stage",
    "DELETE /",
    "POST /stage",
    "POST /commit",
    "show KILO again",
  ])
  expect(store.state.rewound).toBeNull()
  expect(texts(store.state)).toEqual(["KILO one", "One done.", "KILO again", "Back after the first turn."])
})

test("another client's stage, clear and commit hide, bring back and drop the span, and its empty execution shows no turn", async () => {
  const { events, store, cuts, timeline } = await replayed(cutElsewhere)
  expect(
    events.flatMap((event) =>
      event.type === "cut" ? [event.before] : event.type.startsWith("cut.") ? [event.type] : [],
    ),
  ).toEqual(["prompt-2", "cut.undone", "prompt-2", "prompt-3", "cut.committed", "elsewhere", "cut.committed"])
  expect(told(events, "turn.open")).toHaveLength(5)
  expect(cuts.map((at) => at.rewound && { prompts: at.rewound.prompts, keptFiles: at.rewound.keptFiles })).toEqual([
    { prompts: 1, keptFiles: true },
    null,
    { prompts: 1, keptFiles: true },
    { prompts: 1, keptFiles: true },
    null,
    { prompts: 1, keptFiles: true },
    null,
  ])
  // The other client's requests go out on the same transport here; our send commits its stage before the prompt shows,
  // and after its own commit our send has nothing to cut.
  expect(timeline).toEqual([
    "show LIMA one",
    "show LIMA two",
    "POST /stage",
    "DELETE /",
    "POST /stage",
    "POST /commit",
    "show LIMA again",
    "POST /stage",
    "POST /commit",
    "POST /stage",
    "POST /commit",
    "show LIMA last",
  ])
  expect(store.state.rewound).toBeNull()
  expect(texts(store.state)).toEqual(["LIMA one", "One done.", "LIMA last", "Last, after the first."])
})

// The files the scenario's calls changed, prompt by prompt, as the model asked for them.
function scenarioWrites(): Record<string, (old: string | null) => string>[] {
  const [thread] = cut.script.threads
  const writes: Record<string, (old: string | null) => string>[] = []
  for (const step of thread?.steps ?? []) {
    if (!Array.isArray(step)) continue
    const [block] = step
    if (block?.type !== "tool") continue
    const path = String(block.input["path"])
    const { content, oldString, newString } = block.input
    writes.push({
      [path]: (old) =>
        block.name === "write" ? String(content) : (old ?? "").replace(String(oldString), String(newString)),
    })
  }
  return writes
}

test("a rewind to the second prompt puts the files of the second and third back, from the store's points", async () => {
  const { cuts } = await replayed(cut)
  const at = cuts[0]?.state
  if (!at) throw new Error("no cut")
  const points = rewindPoints(at, null)
  expect(
    points.map((point) => point.files.map((file) => [basename(file.path), file.created, file.plus, file.minus])),
  ).toEqual([[["t1.txt", true, 1, 0]], [["a.txt", false, 1, 1]], [["t3.txt", true, 1, 0]]])

  const temp = mkdtempSync(join(tmpdir(), "yellowcode-opencode-cut-"))
  const saved = { HOME: process.env["HOME"], YELLOWCODE_SNAPSHOT_DIR: process.env["YELLOWCODE_SNAPSHOT_DIR"] }
  try {
    mkdirSync(join(temp, "home"))
    process.env["HOME"] = join(temp, "home")
    process.env["YELLOWCODE_SNAPSHOT_DIR"] = join(temp, "store")
    const dir = join(temp, "project")
    mkdirSync(dir)
    for (const [path, content] of Object.entries(KILO_FILES)) writeFileSync(join(dir, path), content)
    const snapshots = await openSnapshots(dir)
    if (!snapshots) throw new Error("snapshots off")
    let taken = 0
    const take = async () => {
      const id = `t${taken++}`
      const point = await snapshots.take(id)
      return point ? { ...point, id } : null
    }
    const prompts = at.items.flatMap((id) => {
      const item = at.byId[id]
      return item?.kind === "user" && item.uuid ? [item.uuid] : []
    })
    expect(prompts).toEqual(["prompt-1", "prompt-2", "prompt-3"])
    const writes = scenarioWrites()
    mkdirSync(join(snapshots.store, "prompts"), { recursive: true })
    // oxlint-disable no-await-in-loop -- each prompt's snapshots follow the one before
    for (const [index, uuid] of prompts.entries()) {
      const before = await take()
      for (const [path, write] of Object.entries(writes[index] ?? {})) {
        const file = join(dir, path)
        writeFileSync(file, write(existsSync(file) ? readFileSync(file, "utf8") : null))
      }
      const after = await take()
      if (!before || !after) throw new Error("no snapshot")
      const segment = {
        kind: "turn",
        before,
        beforeAt: 0,
        after,
        changes: await snapshots.changes(before.tree, after.tree),
        writes: [],
        base: null,
        outside: [],
        outsideKept: [],
      }
      const manifest = { uuid, sessionId: "ses_1", sentAt: 0, segments: [segment], latest: {}, shells: [] }
      writeFileSync(join(snapshots.store, "prompts", `${uuid}.json`), JSON.stringify(manifest))
    }
    // oxlint-enable no-await-in-loop
    const capture: Capture = {
      snapshots: Promise.resolve(snapshots),
      offReason: () => null,
      before: async () => {},
      drop: () => {},
      follow: () => () => {},
      settle: async () => {},
      stop: async () => {},
      snapshot: take,
      release: () => {},
      asked: async () => {},
      adopt: () => {},
    }
    const second = points[1]?.userId
    if (!second) throw new Error("no second prompt")
    const done = await createFileRewind(capture, dir).rewind(at, second, new Set())
    expect(done).toMatchObject({ kind: "done" })
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello\n")
    expect(readFileSync(join(dir, "t1.txt"), "utf8")).toBe("one\n")
    expect(existsSync(join(dir, "t3.txt"))).toBe(false)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(temp, { recursive: true, force: true })
  }
})

test("after a clear, an execution with a step or an error is a turn; only an empty one is held back", async () => {
  const cuts = createCuts(() => [])
  const reader = createEventReader()
  const of = (type: string, data: Record<string, unknown> = {}): OpencodeEvent => {
    const frame = reader({ id: "evt", created: 1, type, data: { sessionID: "s", ...data } })
    if (frame.kind !== "event") throw new Error(`${type} is unreadable`)
    return frame.event
  }
  const passed = (event: OpencodeEvent) => cuts.read(event, "s", 0).passed.map((one) => one.type)
  const clear = () => cuts.read(of("session.revert.cleared"), "s", 0)
  clear()
  expect(passed(of("session.execution.started"))).toEqual([])
  expect(passed(of("session.execution.succeeded"))).toEqual([])
  clear()
  passed(of("session.execution.started"))
  expect(
    passed(
      of("session.step.started", { assistantMessageID: "m", agent: "build", model: { id: "m", providerID: "p" } }),
    ),
  ).toEqual(["session.execution.started", "session.step.started"])
  expect(passed(of("session.execution.succeeded"))).toEqual(["session.execution.succeeded"])
  // Our own clear settles once that turn ended, not at its step.
  cuts.read(of("session.revert.staged", { revert: { messageID: "msg_x" } }), "s", 0)
  const ours = cuts.watch({ type: "cleared" })
  let settled = false
  void ours.settled.then(() => (settled = true))
  clear()
  passed(of("session.execution.started"))
  passed(of("session.step.started", { assistantMessageID: "m", agent: "build", model: { id: "m", providerID: "p" } }))
  await Bun.sleep(0)
  expect(settled).toBe(false)
  passed(of("session.execution.succeeded"))
  await Bun.sleep(0)
  expect(settled).toBe(true)
  clear()
  passed(of("session.execution.started"))
  expect(passed(of("session.execution.failed", { error: { type: "unknown", message: "no" } }))).toEqual([
    "session.execution.started",
    "session.execution.failed",
  ])
})

// opencode's stage goes away both when it was cleared and when it was committed; only a clear brings the span back.
test("a resync tells a clear made meanwhile and a commit, which deleted the span", async () => {
  const session = {
    id: "ses_1",
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: "/project" },
  }
  async function after(found: number) {
    const replies: Record<string, unknown> = {
      "/api/session/ses_1": { data: session },
      "/api/session/ses_1/message": { data: [], cursor: {} },
      "/api/session/active": { data: {} },
      "/api/session/ses_1/permission": { data: [] },
      "/api/session/ses_1/form": { data: [] },
      "/api/session/ses_1/message/msg_prompt-2": { data: {} },
    }
    const transport: Transport = {
      request: ({ path }): Promise<Reply> =>
        path.endsWith("/msg_prompt-2") && found === 404
          ? Promise.resolve({ status: 404, body: { _tag: "MessageNotFoundError", message: "Message not found" } })
          : Promise.resolve({ status: 200, body: replies[path] }),
      events: async function* () {},
      socket: () => Promise.reject(new Error("no socket")),
    }
    const cuts = createCuts(() => [])
    cuts.applied({ type: "staged", message: "msg_prompt-2" })
    const events = await resync(transport, "ses_1", createTranslator(), cuts, 3)
    return { told: events.filter((event) => event.type.startsWith("cut")), cuts }
  }
  expect((await after(200)).told).toEqual([{ type: "cut.undone", at: 3 }])
  const committed = await after(404)
  expect(committed.told).toEqual([{ type: "cut.committed", at: 3 }])
  expect(committed.cuts.deleted("msg_prompt-2")).toBe(true)
})
