import { expect, test } from "bun:test"
import type { Ask, AskReply } from "../agent/ask.ts"
import type { AgentEvent } from "../agent/events.ts"
import { peerAsk } from "../peers/ask.ts"
import { type AskingChild, childAsks } from "./asks.ts"

const edit = (id: string): Ask => ({
  ...peerAsk("x", { from: { id: "", title: "", agent: "" }, to: "", broadcast: false, text: "", images: [] }),
  id,
  call: "tool-1",
  tool: { name: "edit", kind: "edit", mcp: null },
  title: "edit",
  target: "src/a.ts",
  writes: ["src/a.ts"],
  options: [
    ...peerAsk("x", { from: { id: "", title: "", agent: "" }, to: "", broadcast: false, text: "", images: [] }).options,
    {
      id: "always",
      effect: "allow",
      lasts: "project",
      label: null,
      subject: null,
      note: false,
      endsTurn: false,
      mode: null,
    },
  ],
})

const setup = () => {
  const events: AgentEvent[] = []
  const answered: [string, AskReply][] = []
  const child: AskingChild = {
    id: "c1",
    name: "worker",
    provider: "opencode",
    agent: { answer: (ask, reply) => Promise.resolve(void answered.push([ask, reply])) },
  }
  return { events, answered, child, asks: childAsks({ event: (event) => events.push(event) }) }
}

test("a child's ask opens, is answered and closes in the parent", () => {
  const { events, answered, child, asks } = setup()
  const ask = edit("a1")
  expect(asks.take(child, { type: "ask.open", ask, at: 1 })).toBe(true)
  const opened = events[0]
  if (opened?.type !== "ask.open") throw new Error("no ask")
  expect(opened.ask).toMatchObject({ id: "child-c1-a1", title: "worker · opencode wants to edit src/a.ts", call: null })
  expect(opened.ask.options).toEqual(ask.options.filter((option) => option.lasts !== "project"))
  expect(ask.options.some((option) => option.lasts === "project")).toBe(true)

  const reply: AskReply = { type: "option", option: "always", note: null }
  expect(asks.answer("child-c1-a1", reply)).toBe(true)
  expect(answered).toEqual([["a1", reply]])
  expect(asks.answer("a1", reply)).toBe(false)

  expect(asks.take(child, { type: "ask.close", id: "a1", outcome: { status: "allowed" }, at: 2 })).toBe(true)
  expect(events[1]).toMatchObject({ type: "ask.close", id: "child-c1-a1", outcome: { status: "allowed" } })
  expect(asks.take(child, { type: "todos", items: [], at: 3 })).toBe(false)
})

test("a child that ends with an ask open closes the parent's copy", () => {
  const { events, child, asks } = setup()
  asks.take(child, { type: "ask.open", ask: edit("a1"), at: 1 })
  asks.end("c1")
  asks.end("c1")
  expect(events.slice(1)).toMatchObject([{ type: "ask.close", id: "child-c1-a1", outcome: { status: "cancelled" } }])
  expect(asks.answer("child-c1-a1", { type: "declined", chat: false })).toBe(false)
})
