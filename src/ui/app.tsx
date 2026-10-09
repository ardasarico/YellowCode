import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, on, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { settings, stepEffort, stepModel, toggleUltracode } from "../session/settings.ts"
import type { Session } from "../session/types.ts"
import { nextTheme, theme } from "../theme/theme.ts"
import { ChatView, type ScrollState } from "./chat-view.tsx"
import { MIN_CHAT_WIDTH, SIDEBAR_MIN_WIDTH, type SidebarOverride, sidebarShown } from "./layout.ts"
import { noticeFor, type ReplayInfo } from "./notice.ts"
import { PromptBar } from "./prompt-bar.tsx"
import { useSessionTitle } from "./session-title.ts"
import { Sidebar } from "./sidebar.tsx"
import { useTicker } from "./ticker.ts"
import { loadSidebarWidth, saveSidebarWidth } from "./ui-state.ts"
import { Welcome, type Workspace } from "./welcome.tsx"

export type AppProps = {
  session: Session
  model: () => string | null
  workspace: Workspace
  replay: ReplayInfo
  titles: boolean
  onSubmit: (text: string) => void
  onQuit: () => void
}

type Focus = "input" | "chat"

export function App(props: AppProps) {
  const [focus, setFocus] = createSignal<Focus>("input")
  const [selected, setSelected] = createSignal<string | null>(null)
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
  const [overflowing, setOverflowing] = createStore<Record<string, boolean>>({})
  const [scrollState, setScrollState] = createSignal<ScrollState>(
    { atBottom: true, newLines: 0 },
    { equals: (a, b) => a.atBottom === b.atBottom && a.newLines === b.newLines },
  )
  let scroll: ScrollBoxRenderable | undefined
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const welcome = () => props.session.items.length === 0
  const [sidebarWidth, setSidebarWidth] = createSignal(loadSidebarWidth())
  const [override, setOverride] = createSignal<SidebarOverride>(null)
  const title = useSessionTitle(
    () => props.session,
    () => props.titles,
  )
  // A drag that starts on the sidebar edge is captured by whatever lies under the pointer at its first step,
  // so the resize follows drags that bubble up to the layout row.
  const [resizing, setResizing] = createSignal(false)
  // A width saved in a wider terminal still has to fit in half of this one.
  const shownWidth = () => Math.min(sidebarWidth(), Math.max(SIDEBAR_MIN_WIDTH, Math.floor(dimensions().width / 2)))
  const sidebar = () => sidebarShown(dimensions().width, shownWidth(), override())
  const chatWidth = () => dimensions().width - (sidebar() === "docked" ? shownWidth() : 0)
  const [mcpFailure, setMcpFailure] = createSignal<string | null>(null)
  const failedServers = new Set<string>()

  createEffect(() => {
    for (const server of props.session.info?.mcpServers ?? []) {
      if (server.status !== "failed") {
        failedServers.delete(server.name)
        continue
      }
      if (failedServers.has(server.name)) continue
      failedServers.add(server.name)
      if (untrack(sidebar) === "hidden") setMcpFailure(server.name)
    }
  })

  const lastUser = createMemo(() => {
    for (const id of props.session.items.toReversed()) if (props.session.byId[id]?.kind === "user") return id
    return null
  })
  createEffect(on(lastUser, () => setMcpFailure(null), { defer: true }))

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
    if (key.name === "f3") {
      if (!welcome()) setOverride(sidebar() === "hidden" ? "open" : "closed")
      return
    }
    if (key.name === "f4") {
      toggleUltracode()
      return
    }
    if (key.name === "end" && !welcome() && !scrollState().atBottom) {
      key.preventDefault()
      scroll?.scrollTo(scroll.scrollHeight)
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

  const clock = useTicker(() => props.session.usage.warning !== null, 30_000)
  const notice = () => {
    clock()
    return noticeFor({
      usage: props.session.usage,
      scroll: scrollState(),
      replay: props.replay,
      mcpFailure: mcpFailure(),
      now: Date.now(),
    })
  }

  return (
    <Show
      when={!welcome()}
      fallback={
        <Welcome input={input()} workspace={props.workspace} width={dimensions().width} height={dimensions().height} />
      }
    >
      <box
        flexDirection="row"
        flexGrow={1}
        onMouseDown={() => setResizing(false)}
        onMouseDrag={(event) => {
          if (!resizing() || event.isDragging) return
          const width = dimensions().width
          const half = Math.floor(width / 2)
          const max = Math.max(
            SIDEBAR_MIN_WIDTH,
            sidebar() === "docked" ? Math.min(half, width - MIN_CHAT_WIDTH) : half,
          )
          setSidebarWidth(Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, width - event.x)))
        }}
        onMouseUp={() => {
          if (!resizing()) return
          setResizing(false)
          saveSidebarWidth(sidebarWidth())
        }}
      >
        <box flexDirection="column" width={chatWidth()}>
          <ChatView
            session={props.session}
            width={chatWidth()}
            selected={focus() === "chat" ? selected() : null}
            expanded={expanded}
            onOverflow={(id, value) => setOverflowing(id, value)}
            onScrollState={setScrollState}
            scrollRef={(element) => (scroll = element)}
          />
          <PromptBar
            {...input()}
            spaced
            edgeGap={sidebar() === "docked" ? 2 : 0}
            width={chatWidth()}
            notice={notice()}
            context={props.session.usage.context}
          />
        </box>
        <Show when={sidebar() !== "hidden"}>
          <Sidebar
            session={props.session}
            title={title()}
            workspace={props.workspace}
            model={settings.model ?? props.model()}
            width={shownWidth()}
            overlay={sidebar() === "overlay"}
            resizing={resizing()}
            onResizeStart={() => setResizing(true)}
            onJump={(id) => {
              setSelected(id)
              scroll?.scrollChildIntoView(id)
            }}
          />
        </Show>
      </box>
    </Show>
  )
}
