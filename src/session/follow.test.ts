import { expect, test } from "bun:test"
import type { Prompt } from "../agent/agent.ts"
import { follow, showEarly } from "./follow.ts"
import { memoryKind } from "./memory-kind.ts"
import { createSession } from "./session.ts"

const at = 1000

const options = {
  cwd: "/work",
  resume: null,
  mode: null,
  defaultMode: null,
  model: null,
  effort: null,
  extraEffort: false,
  thinking: true,
  instructions: [],
  clientTools: [],
  mcpServers: [],
}

const prompt: Prompt = {
  id: "u1",
  text: "hi",
  images: [],
  command: null,
  to: null,
  delivery: "steer",
  kept: [],
  shells: [],
}

test("a kind's events reach the store, after the prompt shows at Enter", async () => {
  const { kind } = memoryKind()
  const store = createSession({ starting: true })
  const agent = await kind.start(options)
  const following = follow(agent.events, store, "Memory")
  showEarly(store, prompt)
  expect(store.state.status).toBe("running")
  await agent.send(prompt)
  await agent.close()
  await following
  const shown = store.state.items.map((id) => store.state.byId[id])
  expect(shown.map((item) => item?.kind)).toEqual(["user", "text", "turn-end"])
  expect(shown[0]).toMatchObject({ text: "hi", queue: null, uuid: "u1" })
  expect(shown[1]).toMatchObject({ markdown: "hello", streaming: false })
  expect(store.state.status).toBe("idle")
})

test("a stream that fails ends the session with its problem", async () => {
  const memory = memoryKind()
  const store = createSession({ starting: true })
  const agent = await memory.kind.start(options)
  const following = follow(agent.events, store, "Memory")
  memory.fail(new Error("socket closed"))
  await following
  expect(store.state.status).toBe("ended")
  const shown = store.state.items.map((id) => store.state.byId[id])
  expect(shown).toMatchObject([{ kind: "system", text: "Memory stopped" }])
})

test("a stream that fails after its own end keeps the agent's problem alone", async () => {
  const memory = memoryKind()
  const store = createSession({ starting: true })
  const agent = await memory.kind.start(options)
  const following = follow(agent.events, store, "Memory")
  memory.push({ type: "ended", problem: { text: "The service went away", detail: [] }, at })
  memory.fail(new Error("socket closed"))
  await following
  const shown = store.state.items.map((id) => store.state.byId[id])
  expect(shown).toMatchObject([{ kind: "system", text: "The service went away" }])
})
