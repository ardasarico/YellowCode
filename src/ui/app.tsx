import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, on, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { InputProvider } from "../input/provider.ts"
import type { SessionEntry } from "../resume/session-list.ts"
import { settings, stepEffort, stepModel, toggleUltracode } from "../session/settings.ts"
import type { SessionTitle } from "../session/titler.ts"
import type { Ask, Session } from "../session/types.ts"
import { setTheme, theme } from "../theme/theme.ts"
import { AskSurface, pendingAsk } from "./ask/ask-surface.tsx"
import { ChatView, type ScrollState } from "./chat-view.tsx"
import { MIN_CHAT_WIDTH, overrideFor, SIDEBAR_MIN_WIDTH, sidebarShown } from "./layout.ts"
import { noticeFor, type ReplayInfo } from "./notice.ts"
import { PromptBar, promptInnerWidth } from "./prompt-bar.tsx"
import { useSessionTitle } from "./session-title.ts"
import { ResumeDialog } from "./resume/resume-dialog.tsx"
import { SettingsDialog } from "./settings/settings-dialog.tsx"
import { Sidebar } from "./sidebar.tsx"
import { useTicker } from "./ticker.ts"
import { loadSidebarWidth, saveSidebarWidth } from "./ui-state.ts"
import { RECENT_ROWS, Welcome, welcomeLayout, type Workspace } from "./welcome.tsx"

export type AppProps = {
  session: Session
  model: () => string | null
  workspace: Workspace
  replay: ReplayInfo | null
  readOnly?: SessionTitle
  titles: boolean
  settingsProblem: string | null
  provider: InputProvider
  sessions: { list(): Promise<SessionEntry[]>; open(entry: SessionEntry): void }
  earlier?: boolean
  onEarlier?: () => void
  onSubmit: (text: string) => void
  onAnswer: (ask: Ask, response: string) => void
  onQuit: () => void
}

type Focus = "input" | "chat"
type DialogName = "settings" | "resume"

export function App(props: AppProps) {
  const [focus, setFocus] = createSignal<Focus>("input")
  const [listOpen, setListOpen] = createSignal(false)
  const [dialog, setDialog] = createSignal<DialogName | null>(null)
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
  const [recents, setRecents] = createSignal<SessionEntry[]>([])
  // The selected row of the welcome screen's recent sessions; null while the tile has the keys.
  const [recent, setRecent] = createSignal<number | null>(null)
  onMount(() => {
    props.sessions
      .list()
      .then((entries) => setRecents(entries.slice(0, RECENT_ROWS)))
      .catch(() => {})
  })
  const recentShown = () => welcome() && welcomeLayout(dimensions().width, dimensions().height, recents().length).recent
  createEffect(() => {
    if (!recentShown()) setRecent(null)
  })
  const [sidebarWidth, setSidebarWidth] = createSignal(loadSidebarWidth())
  const [override, setOverride] = createSignal(overrideFor(settings.sidebar))
  createEffect(
    on(
      () => settings.sidebar,
      (value) => setOverride(overrideFor(value)),
      { defer: true },
    ),
  )
  const title = useSessionTitle(
    () => props.session,
    () => props.titles,
    untrack(() => props.readOnly),
  )
  // A drag that starts on the sidebar edge is captured by whatever lies under the pointer at its first step,
  // so the resize follows drags that bubble up to the layout row.
  const [resizing, setResizing] = createSignal(false)
  // A width saved in a wider terminal still has to fit in half of this one.
  const shownWidth = () => Math.min(sidebarWidth(), Math.max(SIDEBAR_MIN_WIDTH, Math.floor(dimensions().width / 2)))
  const sidebar = () => sidebarShown(dimensions().width, shownWidth(), override())
  const chatWidth = () => dimensions().width - (sidebar() === "docked" ? shownWidth() : 0)
  const edgeGap = () => (sidebar() === "docked" ? 2 : 0)
  const pending = createMemo(() => pendingAsk(props.session))
  createEffect(
    on(
      () => pending() !== null,
      () => setFocus("input"),
      { defer: true },
    ),
  )
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

  const history = () =>
    props.session.items
      .map((id) => props.session.byId[id])
      .filter((item) => item?.kind === "user")
      .map((item) => item.text)

  const lastUser = createMemo(() => {
    for (const id of props.session.items.toReversed()) if (props.session.byId[id]?.kind === "user") return id
    return null
  })
  createEffect(on(lastUser, () => setMcpFailure(null), { defer: true }))

  const [settingsProblem, setSettingsProblem] = createSignal(untrack(() => props.settingsProblem))
  // `previous` is undefined on the first run and null on the Enter that leaves the welcome screen.
  createEffect(
    on(lastUser, (_, previous) => {
      if (previous) setSettingsProblem(null)
    }),
  )
  createEffect(
    on(
      () => [settings.theme, settings.sidebar, settings.thinking, settings.sessionTitle, settings.permissionMode],
      () => setSettingsProblem(null),
      { defer: true },
    ),
  )

  createEffect(on(() => settings.theme, setTheme, { defer: true }))

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

  // Registered before any ask view mounts, so stopPropagation keeps these keys from an open ask.
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.stopPropagation()
      props.onQuit()
      return
    }
    if (dialog()) return
    const row = recent()
    if (row !== null) {
      // ↑ and Esc give the tile its focus back within this event, so no key may go on to it.
      key.stopPropagation()
      key.preventDefault()
      if (key.ctrl || key.meta || key.shift) return
      if (key.name === "up") setRecent(row === 0 ? null : row - 1)
      else if (key.name === "down") setRecent(Math.min(row + 1, recents().length - 1))
      else if (key.name === "escape") setRecent(null)
      else if (key.name === "return") {
        const entry = recents()[row]
        if (entry) props.sessions.open(entry)
      }
      return
    }
    if (key.name === "f3") {
      key.stopPropagation()
      if (!welcome()) setOverride(sidebar() === "hidden" ? "open" : "closed")
      return
    }
    if (pending()) return
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
    if (key.name === "end" && !welcome() && !scrollState().atBottom) {
      key.preventDefault()
      scroll?.scrollTo(scroll.scrollHeight)
      return
    }
    if (key.name === "tab") {
      if (welcome() || listOpen()) return
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

  const submit = (text: string) => {
    const command = text.trim()
    if (command === "/settings") setDialog("settings")
    else if (command === "/resume") setDialog("resume")
    else props.onSubmit(text)
  }

  const input = () => ({
    focused: focus() === "input" && dialog() === null && recent() === null,
    placeholder: props.readOnly
      ? "Read-only · resuming needs the live connection"
      : "Enter sends the next recorded message",
    model: settings.model ?? props.model(),
    provider: props.provider,
    onSubmit: submit,
  })

  // Built once per request, so a resize or a sidebar toggle keeps the view's cursor.
  const askView = createMemo(
    on(
      () => pending()?.requestId,
      () => {
        const ask = pending()
        if (!ask) return undefined
        return <AskSurface ask={ask} width={promptInnerWidth(chatWidth(), edgeGap())} onAnswer={props.onAnswer} />
      },
    ),
  )

  const clock = useTicker(() => props.session.usage.warning !== null, 30_000)
  const notice = () => {
    clock()
    return noticeFor({
      usage: props.session.usage,
      scroll: scrollState(),
      replay: props.replay,
      readOnly: props.readOnly?.title ?? null,
      mcpFailure: mcpFailure(),
      settingsProblem: settingsProblem(),
      asking: pending() !== null,
      now: Date.now(),
    })
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <Show
        when={!welcome()}
        fallback={
          <Welcome
            input={{
              ...input(),
              onLeaveDown: () => {
                if (recentShown()) setRecent(0)
              },
            }}
            workspace={props.workspace}
            notice={settingsProblem()}
            recent={{ entries: recents(), selected: recent() }}
            width={dimensions().width}
            height={dimensions().height}
            covered={dialog() !== null}
          />
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
              commands={props.provider.commands()}
              width={chatWidth()}
              selected={focus() === "chat" ? selected() : null}
              expanded={expanded}
              onOverflow={(id, value) => setOverflowing(id, value)}
              earlier={props.earlier ?? false}
              onReachTop={() => props.onEarlier?.()}
              onScrollState={setScrollState}
              scrollRef={(element) => (scroll = element)}
            />
            <PromptBar
              {...input()}
              spaced
              edgeGap={edgeGap()}
              width={chatWidth()}
              notice={notice()}
              context={props.session.usage.context}
              ask={askView()}
              history={history}
              onListOpen={setListOpen}
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
      <Show when={dialog() === "settings"}>
        <SettingsDialog onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog() === "resume"}>
        <ResumeDialog sessions={props.sessions} onClose={() => setDialog(null)} />
      </Show>
    </box>
  )
}
