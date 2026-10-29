import { expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { z } from "zod"
import { createDriver, pick } from "../../../../tools/codex/driver.ts"
import { isRaw } from "../../../../tools/codex/scenario.ts"
import { scenarios } from "../../../../tools/codex/scenarios/index.ts"
import { log } from "../../../log/log.ts"
import { readFixture } from "../fixture.ts"
import { replayTransport } from "../replay-transport.ts"
import type { Transport } from "../transport.ts"
import { threadItem } from "./items.ts"
import { createNotificationReader, type ReadNotification } from "./notifications.ts"
import { initializeResult, resultOf, threadStartResult, turnStartResult } from "./thread.ts"

const DIR = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "codex")
const fixture = (name: string) => readFixture(readFileSync(join(DIR, `${name}.jsonl`), "utf8"))
const RESULTS = new Map<string, z.ZodType>([
  ["initialize", initializeResult],
  ["thread/start", threadStartResult],
  ["turn/start", turnStartResult],
])

// What the replay hands out, with each response named by the method it answers.
function tapped(inner: Transport) {
  const asked = new Map<unknown, string>()
  const seen: { method: string; params: unknown; at: unknown; kind: "notification" | "request" | "response" }[] = []
  async function* messages(): AsyncIterable<unknown> {
    for await (const message of inner.messages) {
      const method = pick(message, "method")
      const id = pick(message, "id")
      if (typeof method !== "string")
        seen.push({ method: asked.get(id) ?? "", params: pick(message, "result"), at: null, kind: "response" })
      else {
        const kind = id === undefined ? "notification" : "request"
        seen.push({ method, params: pick(message, "params"), at: pick(message, "emittedAtMs"), kind })
      }
      yield message
    }
  }
  const transport: Transport = {
    ...inner,
    messages: messages(),
    send(message) {
      const method = pick(message, "method")
      if (typeof method === "string") asked.set(pick(message, "id"), method)
      inner.send(message)
    },
  }
  return { transport, seen }
}

test("every message a replay hands out fits its schema, with no item of an unknown type", async () => {
  const info = spyOn(log, "info").mockImplementation(() => {})
  try {
    for (const scenario of scenarios.filter(isRaw)) {
      const replay = replayTransport(fixture(scenario.name))
      const { transport, seen } = tapped(replay)
      // oxlint-disable-next-line no-await-in-loop -- one replay at a time
      await scenario.steps(createDriver(transport, { directory: "<root>/project", timeoutMs: 2_000 }))
      // oxlint-disable-next-line no-await-in-loop -- one replay at a time
      await replay.close()
      const read = createNotificationReader()
      const results: ReadNotification[] = []
      const bad: string[] = []
      for (const message of seen) {
        if (message.kind === "response") {
          const schema = RESULTS.get(message.method)
          if (schema && resultOf(message.params, schema, message.method).kind !== "ok") bad.push(message.method)
          continue
        }
        // Server requests get their schemas with the asks.
        if (message.kind === "request") continue
        const result = read(message.method, message.params, typeof message.at === "number" ? message.at : null)
        if (result.kind === "unreadable") bad.push(result.what)
        results.push(result)
      }
      const items = results.flatMap((result) => {
        if (result.kind !== "notification") return []
        const { notification } = result
        if (notification.method === "item/started" || notification.method === "item/completed")
          return [notification.params.item]
        if (notification.method === "turn/completed") return notification.params.turn.items
        return []
      })
      expect([scenario.name, bad, items.filter((item) => item.type === "unknown")]).toEqual([scenario.name, [], []])
      expect(results.some((result) => result.kind === "notification" && result.at === null)).toBe(false)
    }
  } finally {
    info.mockRestore()
  }
})

test("an extra field passes, a wrong type is unreadable and an unknown method is only seen", () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {})
  const info = spyOn(log, "info").mockImplementation(() => {})
  try {
    const read = createNotificationReader()
    const delta = { threadId: "t", turnId: "u", itemId: "i", delta: "hi" }
    const extra = read("item/agentMessage/delta", { ...delta, later: { x: 1 } }, 5)
    expect(extra.kind === "notification" && extra.notification.method === "item/agentMessage/delta").toBe(true)
    expect(read("item/agentMessage/delta", { ...delta, delta: 42 }, 6)).toEqual({
      kind: "unreadable",
      at: 6,
      what: "item/agentMessage/delta",
    })
    expect(read("thread/new/thing", { text: "private" }, 7)).toEqual({
      kind: "seen",
      at: 7,
      method: "thread/new/thing",
    })
    read("thread/new/thing", {}, 8)
    expect(info).toHaveBeenCalledTimes(1)
    expect(JSON.stringify([...warn.mock.calls, ...info.mock.calls])).not.toContain("private")
  } finally {
    warn.mockRestore()
    info.mockRestore()
  }
  expect(threadItem.parse({ type: "handoff", id: "x", note: "y" })).toEqual({
    type: "unknown",
    id: "x",
    originalType: "handoff",
  })
  expect(threadItem.safeParse({ type: "plan", id: "x", text: 3 }).success).toBe(false)
  expect(resultOf({ userAgent: 1, codexHome: "/h" }, initializeResult, "initialize")).toEqual({
    kind: "unreadable",
    what: "initialize",
  })
})
