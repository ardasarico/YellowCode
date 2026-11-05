import { expect, test } from "bun:test"
import type { AgentEvent } from "../agent/events.ts"
import type { ModelRow } from "../agent/lists.ts"
import { createSubagents } from "./tool.ts"

const row = (provider: string, id: string, label: string): ModelRow => ({
  ref: { provider, id },
  label,
  note: "",
  resolves: null,
  efforts: [],
  images: false,
  window: null,
})

const ROWS: Record<string, ModelRow[]> = {
  opencode: [row("anthropic", "claude-sonnet-4", "Claude Sonnet 4"), row("openai", "gpt-5", "GPT-5")],
  pi: [row("anthropic", "claude-sonnet-4", "Claude Sonnet 4")],
}

function setup(mentioned: string[] = []) {
  const events: AgentEvent[] = []
  const subagents = createSubagents({
    cwd: "/work",
    parent: { event: (event) => events.push(event) },
    providers: () => [
      { id: "opencode", name: "opencode" },
      { id: "pi", name: "Pi" },
    ],
    launcher: () => null,
    modes: () => Promise.resolve([]),
    parentMode: () => "default",
    models: (provider) => Promise.resolve(ROWS[provider] ?? []),
    listed: () => true,
    definitions: () => [],
    mentioned: () => mentioned,
    limit: () => 6,
    tell: () => {},
    close: () => Promise.resolve(),
  })
  return { events, subagents }
}

test("a model name that several providers list asks which one runs; one nobody lists is an error", async () => {
  const { events, subagents } = setup()
  const asked = await subagents.call("run", { model: "Anthropic/Claude-Sonnet-4", task: "review" })
  expect(asked.error).toBe(false)
  const open = events[0]
  expect(open?.type === "ask.open" && open.ask.options.map((option) => option.label)).toEqual([
    "Claude Sonnet 4 · opencode",
    "Claude Sonnet 4 · Pi",
    "Don't run",
  ])

  const none = await subagents.call("run", { model: "gpt-9", task: "review" })
  expect(none).toEqual({ text: "No added provider lists a model named gpt-9.", error: true })
  expect(events).toHaveLength(1)
})

test("a model the user mentioned alone runs without asking; a short name on several rows still asks", async () => {
  const mentioned = setup(["pi/anthropic/claude-sonnet-4"])
  const ran = await mentioned.subagents.call("run", { model: "anthropic/claude-sonnet-4", task: "review" })
  // No launcher in the test, so it fails at the start, after the ask was skipped.
  expect(ran).toEqual({ text: "Did not run: Pi cannot run a subagent.", error: true })
  expect(mentioned.events).toHaveLength(0)

  const short = setup(["claude-sonnet-4"])
  await short.subagents.call("run", { model: "claude-sonnet-4", task: "review" })
  expect(short.events[0]?.type).toBe("ask.open")
})
