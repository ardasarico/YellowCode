import { afterAll, beforeAll, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import type { Ask as AgentAsk, AskReply } from "../agent/ask.ts"
import type { Capabilities } from "../agent/capabilities.ts"
import type { ModeRow } from "../agent/lists.ts"
import { CLAUDE_MODES } from "../agents/claude/lists.ts"
import { withOwnCommands } from "../input/commands.ts"
import type { InputProvider } from "../input/provider.ts"
import { memoryCaps, memoryKind } from "../session/memory-kind.ts"
import { createSession, type SessionStore } from "../session/session.ts"
import { initSettings } from "../session/settings.ts"
import { DEFAULT_SETTINGS } from "../session/settings-file.ts"
import type { Ask } from "../session/types.ts"
import { startTheme } from "../theme/theme.ts"
import { App, type KnobActions, type Message } from "./app.tsx"

const OPENCODE_MODES: ModeRow[] = [
  { id: "build", label: "build", description: "", kind: "auto", cycle: true, available: true, group: null },
  { id: "plan", label: "plan", description: "", kind: "plan", cycle: true, available: true, group: null },
]

const providerOf = (modes: ModeRow[]): InputProvider => ({
  commands: () => withOwnCommands([]),
  blocked: () => false,
  setting: () => null,
  knob: () => null,
  models: () => [],
  modes: () => modes,
  skills: () => null,
  plugins: () => [],
  settingSources: () => [],
  plan: () => null,
  files: () => Promise.resolve([]),
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
const ok = () => Promise.resolve({ ok: true as const, note: null })

// The app as index.tsx runs it: a plan reported without an ask is settled in the store, any other answer goes to the
// agent.
async function render(store: SessionStore, caps: Capabilities, modes: ModeRow[]) {
  const picked: string[] = []
  const sent: Message[] = []
  const answered: [Ask, AskReply][] = []
  const knobs: KnobActions = {
    setMode: (mode) => {
      picked.push(mode)
      return ok()
    },
    setModel: ok,
    setEffort: ok,
    setExtraEffort: ok,
    setThinking: ok,
  }
  const [themed, setThemed] = createSignal(false)
  const kind = memoryKind("agent", "Agent").kind
  const setup = await testRender(
    () => (
      <Show when={themed()}>
        <App
          session={store.state}
          lists={store.lists}
          agent={kind}
          caps={caps}
          model={() => null}
          workspace={{ cwd: "~/work", branch: null, version: "0.0.0" }}
          replay={null}
          settingsProblem={null}
          provider={providerOf(modes)}
          sessions={{ list: () => Promise.resolve({ entries: [], names: null }), open: () => {} }}
          knobs={knobs}
          onSubmit={(message) => {
            sent.push(message)
            return true
          }}
          onAnswer={(ask, reply) => {
            if (ask.ownPlan) store.settlePlan(ask.requestId, reply)
            else answered.push([ask, reply])
          }}
          onInterrupt={() => {}}
          onQuit={() => {}}
        />
      </Show>
    ),
    { width: 100, height: 30 },
  )
  startTheme(setup.renderer.nativeScene, "terminal")
  setThemed(true)
  const screen = async () => {
    await settle()
    await setup.renderOnce()
    return setup.captureCharFrame()
  }
  return { setup, screen, picked, sent, answered }
}

// The test renderer cannot notify.
beforeAll(() => initSettings({ ...DEFAULT_SETTINGS, notifications: "off" }))
afterAll(() => initSettings(DEFAULT_SETTINGS))

// A session in plan mode after its first turn, so the chat shows in place of the welcome screen.
function planning(): SessionStore {
  const store = createSession({ starting: false })
  const prompt = "prompt-1"
  store.event({
    type: "user",
    prompt,
    text: "plan a flag",
    images: [],
    to: null,
    history: false,
    cutPoint: true,
    at: 1,
  })
  store.event({ type: "turn.open", prompts: [prompt], endedTasks: [], at: 1 })
  store.event({
    type: "turn.end",
    error: null,
    interrupted: false,
    local: false,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokens: 0,
    sessionCostUsd: null,
    prompts: [],
    at: 2,
  })
  store.event({ type: "mode", mode: "plan", at: 2 })
  return store
}

const asks = (store: SessionStore) =>
  store.state.items.flatMap((id) => {
    const item = store.state.byId[id]
    return item?.kind === "ask" ? [item] : []
  })

test("a plan the agent reported shows the band, and Yes, start switches to build and sends the start message", async () => {
  const store = planning()
  const { setup, screen, picked, sent } = await render(store, { ...memoryCaps, planSignal: "file" }, OPENCODE_MODES)
  try {
    expect(await screen()).toContain("shift+tab build to start")
    store.event({ type: "plan", text: "1. Add the flag", path: "/home/.opencode/plan/a.md", next: "build", at: 3 })
    const band = await screen()
    expect(band).toContain("Ready to code?")
    expect(band).toContain("1. Add the flag")
    setup.mockInput.pressEnter()
    await screen()
    expect(picked).toEqual(["build"])
    expect(sent.map((message) => message.text)).toEqual(["Implement the plan."])
    expect(asks(store)).toMatchObject([{ ownPlan: { next: "build" }, status: "allowed" }])
  } finally {
    setup.renderer.destroy()
  }
})

test("Keep planning on a reported plan closes the band and sends nothing, since there is no ask for a note", async () => {
  const store = planning()
  const { setup, screen, picked, sent } = await render(store, { ...memoryCaps, planSignal: "file" }, OPENCODE_MODES)
  try {
    store.event({ type: "plan", text: "1. Add the flag", path: "/home/.opencode/plan/a.md", next: "build", at: 3 })
    await screen()
    setup.mockInput.pressKey("2")
    const after = await screen()
    expect(after).not.toContain("Ready to code?")
    expect(picked).toEqual([])
    expect(sent).toEqual([])
    expect(asks(store)).toMatchObject([{ status: "denied" }])
  } finally {
    setup.renderer.destroy()
  }
})

const option = (id: string, effect: "allow" | "deny") => ({
  id,
  effect,
  lasts: "once" as const,
  label: null,
  subject: null,
  note: false,
  endsTurn: false,
  mode: null,
})

test("Claude's plan ask goes to the agent as before, and its plan mode keeps the plain hint", async () => {
  const store = planning()
  const caps = { ...memoryCaps, planSignal: "ask" as const }
  const { setup, screen, picked, sent, answered } = await render(store, caps, CLAUDE_MODES)
  const ask: AgentAsk = {
    id: "ask-1",
    kind: "plan",
    call: "tool-1",
    tool: { name: "ExitPlanMode", kind: "plan", mcp: null },
    title: "ExitPlanMode",
    input: {},
    target: "",
    preview: null,
    writes: [],
    detail: "",
    reason: "",
    options: [option("yes", "allow"), option("no", "deny")],
    questions: null,
    plan: { text: "1. Add the flag", path: null },
    defaultNo: false,
    safety: false,
    by: null,
    own: null,
  }
  try {
    const hint = await screen()
    expect(hint).toContain("shift+tab mode")
    expect(hint).not.toContain("to start")
    store.event({ type: "ask.open", ask, at: 3 })
    expect(await screen()).toContain("Ready to code?")
    setup.mockInput.pressEnter()
    await screen()
    expect(answered.map(([asked, reply]) => [asked.requestId, reply])).toEqual([
      ["ask-1", { type: "option", option: "yes", note: null }],
    ])
    expect(picked).toEqual([])
    expect(sent).toEqual([])
  } finally {
    setup.renderer.destroy()
  }
})
