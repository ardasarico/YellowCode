import { RGBA } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { settings, stepEffort, stepModel, toggleUltracode } from "../session/settings.ts"
import type { Session } from "../session/types.ts"
import { nextTheme, theme } from "../theme/theme.ts"
import { ChatView } from "./chat-view.tsx"
import { InputBlock } from "./input-block.tsx"
import { ReplayBar, type ReplayInfo } from "./replay-bar.tsx"
import { Welcome, type Workspace } from "./welcome.tsx"

export type AppProps = {
  session: Session
  model: () => string | null
  workspace: Workspace
  replay: ReplayInfo
  onSubmit: (text: string) => void
  onQuit: () => void
}

type Focus = "input" | "chat"

export function App(props: AppProps) {
  const [focus, setFocus] = createSignal<Focus>("input")
  const [selected, setSelected] = createSignal<string | null>(null)
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
  const [overflowing, setOverflowing] = createStore<Record<string, boolean>>({})
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const welcome = () => props.session.items.length === 0

  createEffect(() => renderer.setBackgroundColor(theme.background ?? RGBA.defaultBackground()))

  const selectableIds = () =>
    props.session.items.filter((id) => props.session.byId[id]?.kind === "tool" || overflowing[id] === true)

  const toggle = (id: string) => {
    setSelected(id)
    setExpanded(id, (open) => !open)
  }

  const moveSelection = (step: 1 | -1) => {
    const ids = selectableIds()
    if (ids.length === 0) return
    const current = ids.indexOf(selected() ?? "")
    const next = current === -1 ? ids.length - 1 : Math.min(ids.length - 1, Math.max(0, current + step))
    setSelected(ids[next] ?? null)
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      props.onQuit()
      return
    }
    if (key.name === "f2") {
      nextTheme()
      return
    }
    if (key.shift && (key.name === "up" || key.name === "down")) {
      key.preventDefault()
      stepEffort(key.name === "up" ? 1 : -1)
      return
    }
    if (key.shift && (key.name === "left" || key.name === "right")) {
      key.preventDefault()
      stepModel(key.name === "right" ? 1 : -1, props.model())
      return
    }
    if (key.name === "f4") {
      toggleUltracode()
      return
    }
    if (key.name === "tab") {
      if (welcome()) return
      key.preventDefault()
      const next = focus() === "input" ? "chat" : "input"
      setFocus(next)
      if (next === "chat" && selected() === null) moveSelection(-1)
      return
    }
    if (focus() !== "chat") return
    if (key.name === "up") moveSelection(-1)
    else if (key.name === "down") moveSelection(1)
    else if (key.name === "return") {
      const id = selected()
      if (id) toggle(id)
    }
  })

  const input = () => ({
    focused: focus() === "input",
    placeholder: "Enter sends the next recorded message",
    model: settings.model ?? props.model(),
    onSubmit: props.onSubmit,
  })

  return (
    <Show
      when={!welcome()}
      fallback={
        <Welcome input={input()} workspace={props.workspace} width={dimensions().width} height={dimensions().height} />
      }
    >
      <box flexDirection="column" flexGrow={1}>
        <ChatView
          session={props.session}
          selected={focus() === "chat" ? selected() : null}
          expanded={expanded}
          onOverflow={(id, value) => setOverflowing(id, value)}
        />
        <ReplayBar replay={props.replay} focus={focus()} />
        <InputBlock {...input()} width={dimensions().width} />
      </box>
    </Show>
  )
}
