import { expect, test } from "bun:test"
import { createRegistry, type SessionKind } from "./registry.ts"
import type { SessionEntry } from "./sessions.ts"
import { memoryCaps } from "../session/memory-kind.ts"

const entry = (agent: string, id: string, modified: number): SessionEntry => ({
  ref: { agent, id },
  title: id,
  firstPrompt: id,
  cwd: "/work",
  branch: null,
  model: null,
  modified,
})

const kind = (id: string, sessions: () => Promise<SessionEntry[]>): SessionKind => ({
  id,
  name: id,
  caps: memoryCaps,
  sessions,
  history: () => Promise.resolve({ events: [], earlier: null }),
})

test("sessions of every agent merge newest first, and an agent whose list fails is left out", async () => {
  const first = kind("first", () => Promise.resolve([entry("first", "a", 30), entry("first", "b", 10)]))
  const second = kind("second", () => Promise.resolve([entry("second", "a", 40), entry("second", "c", 20)]))
  const broken = kind("broken", () => Promise.reject(new Error("no service")))
  const merged = await createRegistry([first, broken, second]).sessions("/work")
  expect(merged.map((row) => `${row.ref.agent}:${row.ref.id}`)).toEqual(["second:a", "first:a", "second:c", "first:b"])
  const failed = await createRegistry([broken])
    .sessions("/work")
    .catch((error: unknown) => String(error))
  expect(failed).toBe("Error: no service")
})

test("an agent whose list never settles is left out after the wait, unless it is the running one", async () => {
  const quick = kind("quick", () => Promise.resolve([entry("quick", "a", 10)]))
  const stuck = kind("stuck", () => new Promise<never>(() => {}))
  const registry = createRegistry([stuck, quick], 20)
  const merged = await registry.sessions("/work", "quick")
  expect(merged.map((row) => row.ref.agent)).toEqual(["quick"])
  const waited = await Promise.race([
    registry.sessions("/work", "stuck").then(() => "listed"),
    Bun.sleep(60).then(() => "waiting"),
  ])
  expect(waited).toBe("waiting")
})
