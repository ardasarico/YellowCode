import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Prompt } from "../../agent/agent.ts"
import { createSession } from "../../session/session.ts"
import { z } from "zod"
import { readFixture } from "./fixture.ts"
import { createTranslator, type Via } from "./translate.ts"
import { clearedQueue, event, response } from "./wire.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const COMMANDS: Record<string, Via> = { prompt: "start", steer: "steer", follow_up: "queue" }
const command = z.looseObject({ type: z.string(), message: z.string().optional() })

const promptOf = (id: string, text: string): Prompt => ({
  id,
  text,
  images: [],
  command: null,
  to: null,
  delivery: "queue",
  kept: [],
  context: null,
  shells: [],
})

// Plays a recording into a store the way the app does: each prompt shows at once, then pi's lines come through the
// translator. A prompt an Esc took back from pi's queue goes out again as the same prompt.
function played(name: string, exists: (path: string) => boolean = () => false) {
  const fixture = readFixture(readFileSync(join(ROOT, "fixtures", "pi", `${name}.jsonl`), "utf8"))
  const store = createSession()
  const translator = createTranslator("<root>/project", exists)
  let held: Prompt[] = []
  let n = 0
  for (const line of fixture.lines) {
    if (line.kind === "out") {
      const sent = command.safeParse(line.msg)
      const via = sent.success ? COMMANDS[sent.data.type] : undefined
      if (sent.success && via && sent.data.message !== undefined) {
        const again = held.find((prompt) => prompt.text === sent.data.message)
        if (again) {
          held = held.filter((prompt) => prompt !== again)
          translator.sent(again, again.text, via, true)
          continue
        }
        const prompt = promptOf(`prompt-${++n}`, sent.data.message)
        translator.sent(prompt, prompt.text, via)
        store.showEarly({ prompt: prompt.id, text: prompt.text, images: [], to: null, history: false, cutPoint: false })
      }
      continue
    }
    if (line.kind !== "in") continue
    const reply = response.safeParse(line.msg)
    if (reply.success) {
      const cleared = clearedQueue.safeParse(reply.data.data)
      if (reply.data.command === "clear_queue" && cleared.success)
        held = translator.held([...cleared.data.steering, ...cleared.data.followUp])
      continue
    }
    const parsed = event.safeParse(line.msg)
    if (parsed.success) for (const one of translator.event(parsed.data, line.t)) store.event(one)
  }
  const items = store.state.items.map((id) => store.state.byId[id])
  return { store, items, translator }
}

const kinds = (items: ReturnType<typeof played>["items"]) => items.map((item) => item?.kind)

test("a plain answer ends the turn and leaves the session idle", () => {
  const { items, store, translator } = played("hello")
  expect(kinds(items)).toEqual(["user", "text", "turn-end"])
  expect(items[1]).toMatchObject({ markdown: "Hello there.", streaming: false })
  expect(items[2]).toMatchObject({ error: null, interrupted: false, inputTokens: 1200, outputTokens: 180 })
  expect(store.state.status).toBe("idle")
  expect(translator.running()).toBe(false)
})

test("thinking streams before the answer", () => {
  const { items } = played("reasoning")
  expect(kinds(items)).toEqual(["user", "thinking", "text", "turn-end"])
  expect(items[1]).toMatchObject({ text: "The user wants a short greeting. One sentence is enough." })
})

test("a provider error ends the turn with pi's words", () => {
  const { items } = played("error")
  expect(items.at(-1)).toMatchObject({ kind: "turn-end", interrupted: false })
  expect(items.at(-1)).toHaveProperty("error", expect.stringContaining("The mock refused this request."))
})

test("bash, read, edit and write become finished tool rows", () => {
  const bash = played("bash").items.find((item) => item?.kind === "tool")
  expect(bash).toMatchObject({ toolKind: "shell", status: "done", summary: "touch made.txt && ls" })
  const tools = played("edits").items.filter((item) => item?.kind === "tool")
  expect(tools.map((tool) => [tool?.kind === "tool" && tool.toolKind, tool?.kind === "tool" && tool.status])).toEqual([
    ["read", "done"],
    ["edit", "done"],
    ["write", "done"],
  ])
  const edit = tools[1]
  expect(edit?.kind === "tool" && edit.patch?.[0]?.lines).toEqual([
    '-export const greeting = "hello"',
    '+export const greeting = "hello, world"',
  ])
})

test("a steer and a follow-up are taken into the running turn", () => {
  for (const name of ["steer", "follow-up"]) {
    const { items, store } = played(name)
    const users = items.filter((item) => item?.kind === "user")
    expect(users.map((user) => user?.kind === "user" && user.queue)).toEqual([null, null])
    expect(kinds(items).filter((kind) => kind === "turn-end")).toHaveLength(1)
    expect(store.state.status).toBe("idle")
  }
})

test("Esc stops the turn, and what was queued runs next", () => {
  const { items, store } = played("abort")
  const users = items.filter((item) => item?.kind === "user")
  expect(users.map((user) => user?.kind === "user" && [user.text, user.queue])).toEqual([
    ["HANG", null],
    ["QUEUED", null],
  ])
  const ends = items.filter((item) => item?.kind === "turn-end")
  expect(ends.map((end) => end?.kind === "turn-end" && end.interrupted)).toEqual([true, false])
  expect(store.state.status).toBe("idle")
})

const writes = (exists: (path: string) => boolean) =>
  played("edits", exists).items.flatMap((item) =>
    item?.kind === "tool" && item.toolKind === "write" ? item.files.map((file) => [file.path, file.change]) : [],
  )

test("a write is a create only when its file was not there before the call", () => {
  expect(writes(() => false)).toEqual([["<root>/project/notes.md", "create"]])
  expect(writes((path) => path.endsWith("notes.md"))).toEqual([["<root>/project/notes.md", "update"]])
})
