import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AskReply } from "../../agent/ask.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createAsks } from "./asks.ts"
import { readFixture } from "./fixture.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const answers = (value: string): AskReply => ({
  type: "answers",
  answers: { values: { answer: [value] }, fields: {}, notes: {}, note: "" },
})

test("each dialog's answer goes back to pi as the recording's did, and a timeout closes its ask", async () => {
  const fixture = readFixture(readFileSync(join(ROOT, "fixtures", "pi", "dialogs.jsonl"), "utf8"))
  const requests = fixture.lines.flatMap((line) =>
    line.kind === "in" &&
    isRecord(line.msg) &&
    line.msg["type"] === "extension_ui_request" &&
    line.msg["method"] !== "notify"
      ? [line.msg]
      : [],
  )
  const recorded = fixture.lines.flatMap((line) =>
    line.kind === "out" && isRecord(line.msg) && line.msg["type"] === "extension_ui_response" ? [line.msg] : [],
  )
  const sent: Record<string, unknown>[] = []
  const late: AgentEvent[] = []
  const asks = createAsks({
    respond: (id, fields) => sent.push({ type: "extension_ui_response", id, ...fields }),
    tell: (events) => late.push(...events),
  })
  const replies: AskReply[] = [
    { type: "option", option: "yes", note: null },
    answers("Blue"),
    answers("Ada"),
    answers("line one, edited"),
  ]
  const kinds: string[] = []
  const closed: AgentEvent[] = []
  for (const [index, request] of requests.entries()) {
    const [opened] = asks.open(request, 0)
    if (opened?.type === "ask.open") kinds.push(opened.ask.kind)
    const reply = replies[index]
    if (reply && opened?.type === "ask.open") closed.push(...asks.answer(opened.ask.id, reply, 0))
  }
  expect(kinds).toEqual(["permission", "question", "question", "question", "question"])
  expect(sent).toEqual(recorded)
  expect(closed.map((event) => event.type === "ask.close" && event.outcome.status)).toEqual([
    "allowed",
    "answered",
    "answered",
    "answered",
  ])
  await Bun.sleep(400)
  expect(late.map((event) => event.type === "ask.close" && event.outcome.status)).toEqual(["cancelled"])
})

test("a typed answer to a select that is none of its options goes back as no answer", () => {
  const sent: Record<string, unknown>[] = []
  const asks = createAsks({ respond: (_id, fields) => sent.push(fields), tell: () => {} })
  asks.open({ type: "extension_ui_request", id: "s1", method: "select", title: "Pick", options: ["A", "B"] }, 0)
  asks.answer("s1", answers("C"), 0)
  expect(sent).toEqual([{ cancelled: true }])
})
