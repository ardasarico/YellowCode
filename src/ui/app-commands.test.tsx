import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { withOwnCommands } from "../input/commands.ts"
import type { InputProvider } from "../input/provider.ts"
import { memoryCaps, memoryKind } from "../session/memory-kind.ts"
import { createSession } from "../session/session.ts"
import { startTheme } from "../theme/theme.ts"
import { App } from "./app.tsx"

const provider: InputProvider = {
  commands: () => withOwnCommands([]),
  blocked: () => false,
  setting: () => null,
  knob: () => null,
  models: () => [],
  modes: () => [],
  skills: () => null,
  settingSources: () => [],
  plan: () => null,
  files: () => Promise.resolve([]),
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test("an agent that titles its own sessions shows its title, and /rename goes to it with no session id", async () => {
  const store = createSession({ starting: true })
  const caps = { ...memoryCaps, titles: "agent" as const, rename: true }
  const renamed: string[] = []
  const [themed, setThemed] = createSignal(false)
  const setup = await testRender(
    () => (
      <Show when={themed()}>
        <App
          session={store.state}
          lists={store.lists}
          agent={memoryKind().kind}
          caps={caps}
          model={() => null}
          workspace={{ cwd: "~/work", branch: null, version: "0.0.0" }}
          replay={null}
          settingsProblem={null}
          provider={provider}
          sessions={{ list: () => Promise.resolve({ entries: [], names: null }), open: () => {} }}
          onTitle={(title) => renamed.push(title)}
          onSubmit={() => true}
          onAnswer={() => {}}
          onQuit={() => {}}
        />
      </Show>
    ),
    { width: 100, height: 30 },
  )
  const titles: string[] = []
  setup.renderer.setTerminalTitle = (text: string) => void titles.push(text)
  startTheme(setup.renderer.nativeScene, "terminal")
  setThemed(true)
  store.event({ type: "title", title: "Agent title", at: 0 })
  await settle()
  expect(titles.at(-1)).toBe("Agent title")
  await setup.mockInput.typeText("/rename Hand name")
  await settle()
  setup.mockInput.pressEnter()
  await settle()
  expect(renamed).toEqual(["Hand name"])
  expect(titles.at(-1)).toBe("Hand name")
  setup.renderer.destroy()
})

const modelRow = (from: string, id: string, label: string) => ({
  ref: { provider: from, id },
  label,
  note: "",
  resolves: null,
  efforts: ["default", "low", "high"].map((level) => ({ id: level, label: level })),
  images: true,
  window: null,
})

test("an agent with providers lists its models by provider/model, and a pick and an effort step go to it", async () => {
  const sent: string[] = []
  const store = createSession({ starting: true })
  const caps = { ...memoryCaps, effort: true }
  store.event({
    type: "lists",
    lists: {
      models: [
        { provider: { id: "one", name: "First Lab" }, applies: "now", models: [modelRow("one", "alpha", "Alpha")] },
        {
          provider: { id: "two", name: "Second Lab" },
          applies: "now",
          models: [modelRow("two", "alpha", "Alpha Two")],
        },
      ],
    },
    at: 0,
  })
  store.event({ type: "model", model: { provider: "one", id: "alpha" }, at: 0 })
  store.event({ type: "effort", effort: "default", at: 0 })
  const picks: string[] = []
  const knobs = {
    setMode: () => Promise.resolve({ ok: true as const, note: null }),
    setModel: (ref: { provider: string | null; id: string }) => {
      picks.push(`model ${ref.provider}/${ref.id}`)
      store.event({ type: "model", model: ref, at: 0 })
      return Promise.resolve({ ok: true as const, note: null })
    },
    setEffort: (effort: string | null) => {
      picks.push(`effort ${effort}`)
      return Promise.resolve({ ok: true as const, note: null })
    },
    setExtraEffort: () => Promise.resolve({ ok: true as const, note: null }),
    setThinking: () => Promise.resolve({ ok: true as const, note: null }),
  }
  const grouped: InputProvider = {
    ...provider,
    models: () => (store.state.models ?? []).flatMap((group) => group.models),
    modelGroups: () => store.state.models ?? [],
  }
  const [themed, setThemed] = createSignal(false)
  const setup = await testRender(
    () => (
      <Show when={themed()}>
        <App
          session={store.state}
          lists={store.lists}
          agent={memoryKind().kind}
          caps={caps}
          model={() => null}
          workspace={{ cwd: "~/work", branch: null, version: "0.0.0" }}
          replay={null}
          settingsProblem={null}
          provider={grouped}
          knobs={knobs}
          sessions={{ list: () => Promise.resolve({ entries: [], names: null }), open: () => {} }}
          onSubmit={(message) => {
            sent.push(message.text)
            return true
          }}
          onAnswer={() => {}}
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
  await screen()
  setup.mockInput.pressArrow("up", { shift: true })
  await screen()
  await setup.mockInput.typeText("/model")
  await screen()
  setup.mockInput.pressEnter()
  const dialog = await screen()
  expect(dialog).toMatch(/one\/alpha\s+current/)
  expect(dialog).toContain("two/alpha")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await screen()
  expect(picks).toEqual(["effort low", "model two/alpha"])
  // Another client switches the model back.
  store.event({ type: "model", model: { provider: "one", id: "alpha" }, at: 0 })
  expect(await screen()).toContain("✻ one/alpha")
  // Without an /effort of its own the agent would get this as a prompt.
  await setup.mockInput.typeText("/effort auto")
  setup.mockInput.pressEnter()
  expect(await screen()).toContain("has no effort auto")
  expect(sent).toEqual([])
  setup.renderer.destroy()
})

test("/permissions opens the dialog where the agent fills the rules list, and sends nothing to it", async () => {
  const sent: string[] = []
  const refreshed: string[] = []
  const store = createSession({ starting: true })
  const caps = { ...memoryCaps, lists: ["rules" as const] }
  const [themed, setThemed] = createSignal(false)
  const setup = await testRender(
    () => (
      <Show when={themed()}>
        <App
          session={store.state}
          lists={store.lists}
          agent={memoryKind().kind}
          caps={caps}
          model={() => null}
          workspace={{ cwd: "~/work", branch: null, version: "0.0.0" }}
          replay={null}
          settingsProblem={null}
          provider={provider}
          sessions={{ list: () => Promise.resolve({ entries: [], names: null }), open: () => {} }}
          permissions={{
            rules: () => store.lists().rules ?? null,
            refresh: () => refreshed.push("rules"),
            remove: () => Promise.resolve({ ok: true, note: null }),
          }}
          onSubmit={(message) => {
            sent.push(message.text)
            return true
          }}
          onAnswer={() => {}}
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
  const typed = async (text: string) => {
    await setup.mockInput.typeText(text)
    await screen()
    setup.mockInput.pressEnter()
    return screen()
  }
  await screen()
  expect(await typed("/permissions")).toContain("Reading Memory's rules…")
  expect(refreshed).toEqual(["rules"])
  const rule = {
    id: "r1",
    subject: "shell",
    pattern: "ls *",
    effect: "allow" as const,
    lasts: "project" as const,
    origin: null,
    mode: null,
    removable: true,
  }
  store.event({ type: "lists", lists: { rules: [rule] }, at: 0 })
  expect(await screen()).toContain("shell ls *")
  expect(sent).toEqual([])
  setup.renderer.destroy()
})

test("a typed /clear on an agent with none of its own starts a new session and sends nothing", async () => {
  const store = createSession({ starting: true })
  const sent: string[] = []
  let cleared = 0
  const [themed, setThemed] = createSignal(false)
  const setup = await testRender(
    () => (
      <Show when={themed()}>
        <App
          session={store.state}
          lists={store.lists}
          agent={memoryKind().kind}
          caps={memoryCaps}
          model={() => null}
          workspace={{ cwd: "~/work", branch: null, version: "0.0.0" }}
          replay={null}
          settingsProblem={null}
          provider={provider}
          sessions={{ list: () => Promise.resolve({ entries: [], names: null }), open: () => {} }}
          onClear={() => ++cleared > 0}
          onSubmit={(message) => sent.push(message.text) > 0}
          onAnswer={() => {}}
          onQuit={() => {}}
        />
      </Show>
    ),
    { width: 100, height: 30 },
  )
  startTheme(setup.renderer.nativeScene, "terminal")
  setThemed(true)
  await settle()
  await setup.mockInput.typeText("/clear")
  await settle()
  setup.mockInput.pressEnter()
  await settle()
  expect(cleared).toBe(1)
  expect(sent).toEqual([])
  setup.renderer.destroy()
})
