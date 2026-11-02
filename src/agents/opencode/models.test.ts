import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { replayAgent } from "../../../tools/opencode/agent-driver.ts"
import { HAIKU, OPUS } from "../../../tools/opencode/env.ts"
import { agentModel, LAB, models, PLAIN } from "../../../tools/opencode/scenarios/models.ts"
import type { AgentEvent } from "../../agent/events.ts"
import { createSession } from "../../session/session.ts"
import { readFixture } from "./fixture.ts"

const ROOT = join(import.meta.dir, "..", "..", "..")
// Written again only with UPDATE_OPENCODE_GOLDENS=1; the Claude golden test never reads them.
const golden = (name: string) => join(ROOT, "fixtures", "goldens", "opencode", `${name}.json`)

let clock: { mockRestore(): void } | null = null
beforeAll(() => {
  clock = spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
})
afterAll(() => clock?.mockRestore())

// Each answer of the mock ends with the model and effort its request asked for.
async function replayed(scenario: typeof models) {
  const store = createSession({ starting: true })
  const fixture = readFixture(readFileSync(join(ROOT, "fixtures", "opencode", `${scenario.name}.jsonl`), "utf8"))
  const run = await replayAgent((driver) => scenario.run(driver), fixture, { store })
  expect(run.transport.unused()).toEqual([])
  const events = run.events.filter((event) => event.type !== "seen")
  const got = `${JSON.stringify({ events, state: store.state }, null, 2)}\n`
  const file = golden(scenario.name)
  if (process.env["UPDATE_OPENCODE_GOLDENS"] === "1") {
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, got)
  }
  expect(got).toBe(readFileSync(file, "utf8"))
  const knobs = events.flatMap((event: AgentEvent) =>
    event.type === "model"
      ? [`${event.model?.provider}/${event.model?.id}`]
      : event.type === "effort"
        ? [event.effort]
        : [],
  )
  const echoes = events.flatMap((event) =>
    event.type === "text.end" && event.text?.startsWith("(") ? [event.text] : [],
  )
  return { store, events, knobs, echoes }
}

test("models are listed by provider, and model and effort switches reach the requests", async () => {
  const { store, events, knobs, echoes } = await replayed(models)

  const groups = events.flatMap((event) => (event.type === "lists" && event.lists.models ? [event.lists.models] : []))
  expect(groups).toHaveLength(2)
  expect(groups[0]?.map((group) => [group.provider?.name, group.applies])).toEqual([
    ["Anthropic", "now"],
    ["Second Lab", "now"],
  ])
  expect(groups[0]?.[1]?.models).toEqual([
    {
      ref: { provider: "lab", id: LAB },
      label: "Lab One",
      note: "",
      resolves: null,
      efforts: ["default", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id })),
      images: true,
      window: 200000,
    },
  ])
  expect(knobs).toEqual([
    `anthropic/${OPUS}`,
    "default",
    "high",
    `anthropic/${HAIKU}`,
    "high",
    `lab/${LAB}`,
    "high",
    "default",
    // Opened again.
    `lab/${LAB}`,
    "default",
  ])
  expect(echoes).toEqual([
    `(${OPUS}, effort none)`,
    `(${OPUS}, effort high)`,
    `(${HAIKU}, effort high)`,
    `(${LAB}, effort high)`,
    `(${LAB}, effort none)`,
    `(${LAB}, effort none)`,
  ])
  expect([store.state.model, store.state.effort]).toEqual([{ provider: "lab", id: LAB }, "default"])
})

// Without a pick the session runs its mode's model: build's own haiku, plan's default opus.
test("the knobs follow the mode's own model until a pick, and a model without levels has no effort", async () => {
  const { store, knobs, echoes } = await replayed(agentModel)
  expect(knobs).toEqual([
    `anthropic/${HAIKU}`,
    "default",
    `anthropic/${OPUS}`,
    "default",
    `anthropic/${HAIKU}`,
    "default",
    "high",
    `plain/${PLAIN}`,
    null,
  ])
  expect(echoes).toEqual([
    `(${HAIKU}, effort none)`,
    `(${OPUS}, effort none)`,
    `(${HAIKU}, effort high)`,
    `(${PLAIN}, effort none)`,
  ])
  expect([store.state.model, store.state.effort]).toEqual([{ provider: "plain", id: PLAIN }, null])
})
