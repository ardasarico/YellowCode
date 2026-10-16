import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { type Draft, draftFromMessage } from "../input/draft.ts"
import type { InputProvider } from "../input/provider.ts"
import { log } from "../log/log.ts"
import type { OutgoingImage } from "../protocol/outgoing.ts"
import type { SessionEntry } from "../resume/session-list.ts"
import { type RewindExtras, type Rewound, rewindPoints } from "../session/rewind.ts"
import { settings, stepEffort, stepModel, toggleUltracode } from "../session/settings.ts"
import { runningShellCount, shellNodeId, shellTasks } from "../session/shells.ts"
import type { SessionTitle } from "../session/titler.ts"
import type { Ask, ChatImage, Session, SessionInfo } from "../session/types.ts"
import { setTheme, theme } from "../theme/theme.ts"
import { AgentPanel, panelNodes, shownNodes } from "./agents/agent-panel.tsx"
import { AgentView } from "./agents/agent-view.tsx"
import { agentTree, isAgentCall, isWorkflowCall } from "./agents/tree.ts"
import { AskSurface, pendingAsk } from "./ask/ask-surface.tsx"
import { useAttention } from "./attention.ts"
import { ChatView, type ScrollState } from "./chat-view.tsx"
import type { Submission } from "./completion.ts"
import { CodeView } from "./dialog/code-view.tsx"
import { ImageView } from "./dialog/image-view.tsx"
import { windowTitle } from "./format.ts"
import { itemImages, labelId, labelTarget, loadImage } from "./image-label.tsx"
import { messageFolds } from "./markdown/folds.ts"
import { type FileRef, isImagePath, messageRefs, messageTargets, refId, refTarget } from "./markdown/refs.ts"
import { MIN_CHAT_WIDTH, overrideFor, SIDEBAR_MIN_WIDTH, sidebarShown } from "./layout.ts"
import { noticeFor, quitHint, type ReplayInfo } from "./notice.ts"
import { PromptBar, promptInnerWidth } from "./prompt-bar.tsx"
import { useSessionTitle } from "./session-title.ts"
import { ResumeDialog } from "./resume/resume-dialog.tsx"
import { RewindDialog } from "./rewind/rewind-dialog.tsx"
import { SettingsDialog, type SettingsTab } from "./settings/settings-dialog.tsx"
import { ThemeDialog } from "./settings/theme-dialog.tsx"
import { SkillsDialog } from "./skills/skills-dialog.tsx"
import { Sidebar } from "./sidebar.tsx"
import { useTicker } from "./ticker.ts"
import { loadSidebarWidth, saveSidebarWidth } from "./ui-state.ts"
import { RECENT_ROWS, Welcome, welcomeLayout, type Workspace } from "./welcome.tsx"

const QUIT_WINDOW = 2000

export type AppProps = {
  session: Session
  model: () => string | null
  // Stands in for session.info until the real init arrives.
  firstInfo?: SessionInfo | null
  workspace: Workspace
  replay: ReplayInfo | null
  readOnly?: SessionTitle & { modified: number }
  titles: boolean
  settingsProblem: string | null
  provider: InputProvider
  sessions: { list(): Promise<SessionEntry[]>; open(entry: SessionEntry): void }
  earlier?: boolean
  onEarlier?: () => void
  onSubmit: (text: string, images: OutgoingImage[]) => void
  onAnswer: (ask: Ask, response: string) => void
  onQuit: () => void
  // Without it the session cannot rewind (a read-only transcript).
  rewind?: { extras: RewindExtras | null; onRewind: (rewound: Rewound) => void; onRedo: () => void }
}

type Focus = "input" | "chat" | "panel" | "shells"
type DialogName =
  | { name: "settings"; tab: SettingsTab }
  | { name: "resume" | "theme" | "skills" | "rewind" }
  | { name: "image"; images: ChatImage[]; index: number }
  | { name: "code"; refs: FileRef[]; ids: string[]; index: number }

export function App(props: AppProps) {
  const [focus, setFocus] = createSignal<Focus>("input")
  const [listOpen, setListOpen] = createSignal(false)
  const [dialog, setDialog] = createSignal<DialogName | null>(null)
  const settingsTab = () => {
    const open = dialog()
    return open?.name === "settings" ? open.tab : null
  }
  const [fill, setFill] = createSignal<{ draft: Draft; seq: number }>()
  const [selected, setSelected] = createSignal<string | null>(null)
  const [agentView, setAgentView] = createSignal<string | null>(null)
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
  const flagged = untrack(() => props.readOnly)
    ? () => false
    : useAttention(
        renderer,
        () => props.session,
        () => settings.notifications,
      )
  createEffect(() => {
    const text = `${flagged() ? "(!) " : ""}${windowTitle(title()?.title ?? "") || "YellowCode"}`
    try {
      renderer.setTerminalTitle(text)
    } catch (error) {
      log.warn("cannot set the window title", error)
    }
  })
  // A drag that starts on the sidebar edge is captured by whatever lies under the pointer at its first step,
  // so the resize follows drags that bubble up to the layout row.
  const [resizing, setResizing] = createSignal(false)
  // A width saved in a wider terminal still has to fit in half of this one.
  const layout = () => sidebarShown(dimensions().width, sidebarWidth(), override())
  const shownWidth = () => layout().width
  const sidebar = () => layout().mode
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
  createEffect(() => {
    if (pending()) setAgentView(null)
  })
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

  const userItems = () =>
    props.session.items.map((id) => props.session.byId[id]).filter((item) => item?.kind === "user")
  // The drafts of messages sent from here, by the index their user item will get, so a recalled message gets its chips
  // back. The text check skips a draft whose message never arrived.
  const drafts = new Map<number, { text: string; draft: Draft }>()
  const history = () =>
    userItems().map((item, index) => {
      const sent = drafts.get(index)
      return sent?.text === item.text ? sent.draft : draftFromMessage(item.text, item.images)
    })

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

  createEffect(() => renderer.setBackgroundColor(theme.canvas))

  const selectableIds = () =>
    props.session.items.flatMap((id) => {
      const item = props.session.byId[id]
      const own = item?.kind === "tool" || overflowing[id] === true ? [id] : []
      const folds = item?.kind === "text" ? messageFolds(item.markdown, id, expanded) : []
      const refs = item?.kind === "text" ? messageRefs(item.markdown, id, process.cwd(), expanded) : []
      const labels = itemImages(item, process.cwd()).flatMap((image, index) =>
        loadImage(image) ? [labelId(id, index)] : [],
      )
      return [...own, ...folds, ...refs, ...labels]
    })

  // The image a `[Image N]` mention points at: image N of the latest user message before it that has one.
  const mentionedImages = (itemId: string, n: number) => {
    const before = props.session.items.slice(0, props.session.items.indexOf(itemId))
    for (const id of before.toReversed()) {
      const item = props.session.byId[id]
      if (item?.kind === "user" && item.images.length >= n) return { images: item.images, index: n - 1 }
    }
    return null
  }

  const openRef = (id: string) => {
    const target = refTarget(id)
    const item = target && props.session.byId[target.itemId]
    if (!target || item?.kind !== "text") return
    const all = messageTargets(item.markdown, process.cwd())
    const picked = all[target.index]
    if (!picked) return
    setSelected(id)
    if (picked.kind === "image") {
      const found = mentionedImages(target.itemId, picked.n)
      if (found) setDialog({ name: "image", ...found })
      return
    }
    if (isImagePath(picked.ref.path)) {
      const { path } = picked.ref
      const name = path.split("/").at(-1) ?? path
      setDialog({ name: "image", images: [{ name, mediaType: "", data: null, path }], index: 0 })
      return
    }
    const files = all.flatMap((entry, index) =>
      entry.kind === "file" && !isImagePath(entry.ref.path)
        ? [{ ref: entry.ref, id: refId(target.itemId, index) }]
        : [],
    )
    setDialog({
      name: "code",
      refs: files.map((file) => file.ref),
      ids: files.map((file) => file.id),
      index: files.findIndex((file) => file.id === id),
    })
  }
  const codeView = () => {
    const open = dialog()
    return open?.name === "code" ? open : null
  }

  const imageView = () => {
    const open = dialog()
    return open?.name === "image" ? open : null
  }
  const openImage = (id: string) => {
    const target = labelTarget(id)
    if (!target) return
    const all = itemImages(props.session.byId[target.itemId], process.cwd())
    const label = all[target.index]
    if (!label || !loadImage(label)) return
    // A missing file has nothing to show, so the view skips it.
    const images = all.filter((image) => loadImage(image))
    setSelected(id)
    setDialog({ name: "image", images, index: images.indexOf(label) })
  }

  const toggle = (id: string) => {
    setSelected(id)
    setExpanded(id, (open) => !open)
  }

  const isAgentRow = (id: string) => {
    const item = props.session.byId[id]
    return item?.kind === "tool" && (isAgentCall(item) || isWorkflowCall(item))
  }

  const openAgentView = (id: string) => {
    if (!pending()) setAgentView(id)
  }

  const toggleAgentView = () => {
    if (agentView() !== null) {
      setAgentView(null)
      return
    }
    const top = agentTree(props.session).filter((node) => node.depth === 1)
    const target = top.findLast((node) => node.state === "running") ?? top.at(-1)
    if (target) openAgentView(target.id)
    else openShells()
  }

  const shellCount = () => runningShellCount(props.session)
  createEffect(() => {
    if (focus() === "shells" && (shellCount() === 0 || pending())) setFocus("input")
  })
  const openShells = () => {
    const first = shellTasks(props.session)[0]
    if (!first) return
    setFocus("input")
    openAgentView(shellNodeId(first.id))
  }

  const panel = createMemo(() => (pending() ? [] : panelNodes(props.session)))
  const [panelPick, setPanelPick] = createSignal<string | null>(null)
  const panelIds = () => shownNodes(panel()).map((node) => node.id)
  const panelSelected = () => {
    if (focus() !== "panel") return null
    const ids = panelIds()
    const pick = panelPick()
    return pick !== null && ids.includes(pick) ? pick : (ids[0] ?? null)
  }
  createEffect(() => {
    if (focus() === "panel" && panel().length === 0) setFocus("input")
  })
  const enterPanel = () => {
    const first = panelIds()[0]
    if (!first) return
    setPanelPick(first)
    setFocus("panel")
  }
  const openFromPanel = (id: string) => {
    setFocus("input")
    openAgentView(id)
  }
  const panelKey = (name: string | undefined) => {
    const ids = panelIds()
    const at = ids.indexOf(panelSelected() ?? "")
    if (name === "up") {
      if (at <= 0) setFocus(shellCount() > 0 ? "shells" : "input")
      else setPanelPick(ids[at - 1] ?? null)
    } else if (name === "down") setPanelPick(ids[Math.min(at + 1, ids.length - 1)] ?? null)
    else if (name === "escape") setFocus("input")
    else if (name === "return") {
      const id = panelSelected()
      if (id) openFromPanel(id)
    }
  }

  const moveSelection = (step: 1 | -1) => {
    const ids = selectableIds()
    if (ids.length === 0) return
    const current = ids.indexOf(selected() ?? "")
    const next = current === -1 ? ids.length - 1 : Math.min(ids.length - 1, Math.max(0, current + step))
    setSelected(ids[next] ?? null)
  }

  // The first Ctrl+C only warns, so a stray press does not end the session.
  const [quitArmed, setQuitArmed] = createSignal(false)
  let disarm: ReturnType<typeof setTimeout> | undefined
  const pressQuit = () => {
    if (quitArmed()) return props.onQuit()
    setQuitArmed(true)
    clearTimeout(disarm)
    disarm = setTimeout(() => setQuitArmed(false), QUIT_WINDOW)
  }
  onCleanup(() => clearTimeout(disarm))

  // Esc on an empty idle prompt arms the rewind; a second Esc within the window opens it.
  const [rewindArmed, setRewindArmed] = createSignal(false)
  let disarmRewind: ReturnType<typeof setTimeout> | undefined
  const canRewind = () =>
    props.rewind !== undefined && props.session.status !== "running" && !pending() && userItems().length > 0
  const openRewind = () => {
    setRewindArmed(false)
    if (canRewind()) setDialog({ name: "rewind" })
  }
  const pressEscape = () => {
    if (!canRewind()) return
    if (rewindArmed()) return openRewind()
    setRewindArmed(true)
    clearTimeout(disarmRewind)
    disarmRewind = setTimeout(() => setRewindArmed(false), QUIT_WINDOW)
  }
  onCleanup(() => clearTimeout(disarmRewind))
  const rewind = (rewound: Rewound) => {
    const index = userItems().findIndex((item) => item.id === rewound.userId)
    props.rewind?.onRewind(rewound)
    const draft = history()[index]
    if (draft) setFill((previous) => ({ draft, seq: (previous?.seq ?? 0) + 1 }))
  }
  const redo = () => {
    if (props.session.rewound) props.rewind?.onRedo()
  }

  // Registered before any ask view mounts, so stopPropagation keeps these keys from an open ask.
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      // A focused prompt takes it: it clears its text, or calls pressQuit when empty.
      if (input().focused && !pending()) return
      key.stopPropagation()
      pressQuit()
      return
    }
    if (dialog()) return
    if (key.ctrl && key.name === "t") {
      key.preventDefault()
      key.stopPropagation()
      if (!pending()) toggleAgentView()
      return
    }
    if (agentView() !== null) return
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
    if (
      focus() === "panel" &&
      !key.ctrl &&
      !key.meta &&
      !key.shift &&
      (key.name === "up" || key.name === "down" || key.name === "escape" || key.name === "return")
    ) {
      key.preventDefault()
      key.stopPropagation()
      panelKey(key.name)
      return
    }
    if (
      focus() === "shells" &&
      !key.ctrl &&
      !key.meta &&
      !key.shift &&
      (key.name === "up" || key.name === "down" || key.name === "escape" || key.name === "return")
    ) {
      key.preventDefault()
      key.stopPropagation()
      if (key.name === "down") enterPanel()
      else if (key.name === "return") openShells()
      else setFocus("input")
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
      if (id && labelTarget(id)) openImage(id)
      else if (id && refTarget(id)) openRef(id)
      else if (id && isAgentRow(id)) setAgentView(id)
      else if (id) toggle(id)
    }
  })

  const submit = ({ text, images, draft }: Submission) => {
    const command = text.trim()
    if (command === "/settings") setDialog({ name: "settings", tab: "config" })
    else if (command === "/resume") setDialog({ name: "resume" })
    else if (command === "/theme") setDialog({ name: "theme" })
    else if (command === "/mcp") setDialog({ name: "settings", tab: "mcp" })
    else if (command === "/plugins") setDialog({ name: "settings", tab: "plugins" })
    else if (command === "/skills") setDialog({ name: "skills" })
    else if (command === "/rewind" && props.rewind) openRewind()
    else if (command === "/redo" && props.rewind) redo()
    else {
      if (draft.chips.length > 0) drafts.set(userItems().length, { text, draft })
      props.onSubmit(text, images)
    }
  }

  const input = () => ({
    focused: focus() === "input" && dialog() === null && recent() === null && agentView() === null,
    placeholder: props.readOnly
      ? "Read-only · resuming needs the live connection"
      : "Enter sends the next recorded message",
    model: settings.model ?? props.model(),
    provider: props.provider,
    onSubmit: submit,
    onQuit: pressQuit,
    onEscape: pressEscape,
    fill: fill(),
  })

  // Built once per request, so a resize or a sidebar toggle keeps the view's cursor.
  const askView = createMemo(
    on(
      () => pending()?.requestId,
      () => {
        const ask = pending()
        if (!ask) return undefined
        return (
          <AskSurface
            ask={ask}
            width={promptInnerWidth(chatWidth(), edgeGap())}
            onAnswer={props.onAnswer}
            onOpenImages={(images, index) => setDialog({ name: "image", images, index })}
          />
        )
      },
    ),
  )

  const welcomeNotice = () => {
    if (quitArmed()) return quitHint()
    const problem = settingsProblem()
    return problem ? { text: problem, fg: theme.warning } : null
  }

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
      quitArmed: quitArmed(),
      rewindArmed: rewindArmed(),
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
            notice={welcomeNotice()}
            recent={{ entries: recents(), selected: recent() }}
            width={dimensions().width}
            height={dimensions().height}
          />
        }
      >
        <Show when={agentView()}>
          {(id) => (
            <AgentView
              session={props.session}
              selected={id()}
              onSelect={setAgentView}
              onClose={() => setAgentView(null)}
              width={dimensions().width}
              height={dimensions().height}
            />
          )}
        </Show>
        <box
          flexDirection="row"
          flexGrow={1}
          visible={agentView() === null}
          onMouseDown={() => setResizing(false)}
          onMouseDrag={(event) => {
            if (!resizing() || event.isDragging) return
            const width = dimensions().width
            const half = Math.floor(width / 2)
            const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(half, width - MIN_CHAT_WIDTH))
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
              onToggle={(id) => setExpanded(id, (open) => !open)}
              onOpenAgent={openAgentView}
              onOpenImage={openImage}
              onOpenRef={openRef}
              earlier={props.earlier ?? false}
              onReachTop={() => props.onEarlier?.()}
              onScrollState={setScrollState}
              scrollRef={(element) => (scroll = element)}
              onRedo={redo}
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
              onLeaveDown={() => (shellCount() > 0 ? setFocus("shells") : enterPanel())}
              agents={panel().length > 0}
              shells={{ count: shellCount(), selected: focus() === "shells", onOpen: openShells }}
            />
            <Show when={panel().length > 0}>
              <AgentPanel
                nodes={panel()}
                selected={panelSelected()}
                width={chatWidth() - 1 - edgeGap()}
                onOpen={openFromPanel}
              />
            </Show>
          </box>
          <Show when={sidebar() !== "hidden"}>
            <Sidebar
              session={props.session}
              title={title()}
              workspace={props.workspace}
              modified={props.readOnly?.modified}
              model={settings.model ?? props.model()}
              width={shownWidth()}
              resizing={resizing()}
              onResizeStart={() => setResizing(true)}
            />
          </Show>
        </box>
      </Show>
      <Show when={settingsTab()}>
        {(tab) => (
          <SettingsDialog
            tab={tab()}
            info={props.session.info ?? props.firstInfo ?? null}
            title={title()?.title ?? null}
            model={settings.model ?? props.model()}
            version={props.workspace.version}
            skills={props.provider.skills().length}
            skillRows={props.provider.skillRows()}
            pluginHooks={props.provider.pluginHooks()}
            sources={props.provider.settingsSources()}
            onTab={(next) => setDialog({ name: "settings", tab: next })}
            onClose={() => setDialog(null)}
          />
        )}
      </Show>
      <Show when={dialog()?.name === "theme"}>
        <ThemeDialog onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog()?.name === "skills"}>
        <SkillsDialog
          skills={props.provider.skills()}
          onUse={(command) => {
            setDialog(null)
            setFill((previous) => ({ draft: { text: `/${command} `, chips: [] }, seq: (previous?.seq ?? 0) + 1 }))
          }}
          onClose={() => setDialog(null)}
        />
      </Show>
      <Show when={imageView()}>
        {(view) => (
          <ImageView
            images={view().images}
            index={view().index}
            onIndex={(index) => setDialog({ ...view(), index })}
            onClose={() => setDialog(null)}
          />
        )}
      </Show>
      <Show when={codeView()}>
        {(view) => (
          <CodeView
            refs={view().refs}
            index={view().index}
            onIndex={(index) => {
              setSelected(view().ids[index] ?? null)
              setDialog({ ...view(), index })
            }}
            onClose={() => setDialog(null)}
          />
        )}
      </Show>
      <Show when={dialog()?.name === "resume"}>
        <ResumeDialog sessions={props.sessions} onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog()?.name === "rewind" && props.rewind}>
        {(options) => {
          // Nothing can change the points while the dialog is open, so they are worked out once.
          const points = untrack(() => rewindPoints(props.session, options().extras))
          return <RewindDialog points={points} onRewind={rewind} onClose={() => setDialog(null)} />
        }}
      </Show>
    </box>
  )
}
