import { expect, test } from "bun:test"
import type { Agent, StartOptions } from "../agent/agent.ts"
import type { AgentEvent } from "../agent/events.ts"
import type { ModeRow } from "../agent/lists.ts"
import { memoryCaps, memoryKind } from "../session/memory-kind.ts"
import { type ChildResult, createChildren, type Launcher, type SpawnRequest } from "./children.ts"

const at = 1000
const ok = { ok: true as const, note: null }

// Each started agent opens a turn per prompt and ends it only when the test says, after a write of `file`.
function fakeLauncher() {
  const started: { options: StartOptions; prompts: string[]; end(file?: string): void }[] = []
  const launcher: Launcher = {
    id: "fake",
    name: "Fake",
    caps: { ...memoryCaps, instructions: true },
    async start(options) {
      const memory = memoryKind()
      const base: Agent = await memory.kind.start(options)
      const prompts: string[] = []
      const entry = {
        options,
        prompts,
        end(file?: string) {
          const events: AgentEvent[] = [
            { type: "text.start", part: "t", parent: null, text: "done", local: false, quiet: false, at },
            { type: "text.end", part: "t", text: null, at },
          ]
          if (file)
            events.unshift(
              {
                type: "tool.start",
                id: "w",
                parent: null,
                name: "Write",
                kind: "write",
                title: "Write",
                mcp: null,
                quiet: false,
                at,
              },
              {
                type: "tool.end",
                id: "w",
                status: "done",
                result: "",
                images: [],
                patch: null,
                created: true,
                content: null,
                unchanged: false,
                exitCode: null,
                count: null,
                outcome: null,
                background: false,
                task: null,
                files: [{ path: file, change: "create", movedTo: null, patch: null, after: null }],
                at,
              },
            )
          memory.push(...events, {
            type: "turn.end",
            error: null,
            interrupted: false,
            local: false,
            durationMs: 1,
            inputTokens: 1,
            outputTokens: 1,
            tokens: 2,
            sessionCostUsd: null,
            prompts: [],
            at,
          })
        },
      }
      started.push(entry)
      return {
        ...base,
        send(prompt) {
          entry.prompts.push(prompt.text)
          memory.push({ type: "turn.open", prompts: [prompt.id], endedTasks: [], at })
          return Promise.resolve(ok)
        },
      }
    },
  }
  return { launcher, started }
}

const row = (kind: ModeRow["kind"]): ModeRow => ({
  id: kind,
  label: kind,
  description: "",
  kind,
  cycle: true,
  available: true,
  group: null,
})

function setup(limit: number) {
  const fake = fakeLauncher()
  const results: ChildResult[] = []
  let clock = 0
  const children = createChildren({
    limit: () => limit,
    confirm: () => Promise.resolve(false),
    onResult: (_, result) => results.push(result),
    now: () => (clock += 10),
  })
  const request = (task: string): SpawnRequest => ({
    launcher: fake.launcher,
    definition: { name: "worker", permissions: "edits", plugins: false, instructions: "Be brief." },
    model: { provider: null, id: "m" },
    task,
    prompt: task,
    cwd: "/work",
    parentMode: "edits",
    modes: [row("default"), row("edits")],
  })
  return { ...fake, children, results, request }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const states = (children: ReturnType<typeof setup>["children"]) => children.list().map((child) => child.state)

test("children past the limit wait, and an idle child does not count", async () => {
  const { children, started, request, results } = setup(1)
  await children.spawn(request("a"))
  await children.spawn(request("b"))
  await tick()
  expect(states(children)).toEqual(["running", "queued"])
  expect(started[0]?.options).toMatchObject({
    ephemeral: true,
    plain: true,
    mode: "edits",
    instructions: ["Be brief."],
  })

  started[0]?.end("/work/a.ts")
  await tick()
  await tick()
  expect(states(children)).toEqual(["idle", "running"])
  expect(results[0]).toEqual({ text: "done", files: ["/work/a.ts"], durationMs: 10, error: null })

  expect(children.send("c1", "more").ok).toBe(true)
  expect(states(children)).toEqual(["queued", "running"])
  await children.close("c2")
  await tick()
  expect(states(children)).toEqual(["running", "closed"])
  expect(started[0]?.prompts).toEqual(["a", "more"])
})

test("a stopped queued child never starts", async () => {
  const { children, started, request } = setup(1)
  await children.spawn(request("a"))
  await children.spawn(request("b"))
  expect((await children.stop("c2")).ok).toBe(true)
  started[0]?.end()
  await tick()
  await tick()
  expect(states(children)).toEqual(["idle", "stopped"])
  expect(started).toHaveLength(1)
  await children.closeAll()
  expect(states(children)).toEqual(["closed", "closed"])
})

test("a mode wider than allowed runs only on the user's yes", async () => {
  const { children, request } = setup(1)
  const spawned = await children.spawn({ ...request("a"), modes: [row("bypass")] })
  expect(spawned.ok).toBe(false)
  expect(children.list()).toHaveLength(0)
})

test("a child that fails before its first turn reports its own time, and a rejected send frees its slot", async () => {
  const { children, request, results, launcher } = setup(1)
  const broken: Launcher = { ...launcher, start: () => Promise.reject(new Error("no binary")) }
  await children.spawn({ ...request("a"), launcher: broken })
  await tick()
  expect(results[0]).toMatchObject({ error: "Fake did not start: no binary", durationMs: 10 })

  const rejecting: Launcher = {
    ...launcher,
    start: async (options, store) => ({
      ...(await launcher.start(options, store)),
      send: () => Promise.reject(new Error("gone")),
    }),
  }
  await children.spawn({ ...request("b"), launcher: rejecting })
  await children.spawn(request("c"))
  await tick()
  await tick()
  expect(states(children)).toEqual(["failed", "failed", "running"])
})

test("a spawn waiting for the user's yes is refused once the session closes", async () => {
  const { request } = setup(1)
  const yes = Promise.withResolvers<boolean>()
  const waiting = createChildren({ limit: () => 1, confirm: () => yes.promise, onResult: () => {} })
  const spawned = waiting.spawn({ ...request("a"), modes: [row("bypass")] })
  await waiting.closeAll()
  yes.resolve(true)
  expect(await spawned).toEqual({ ok: false, problem: "the session closed" })
  expect(waiting.list()).toHaveLength(0)
})
