import type { Agent, AgentKind, Prompt } from "../agent/agent.ts"
import type { AskReply } from "../agent/ask.ts"
import type { Capabilities } from "../agent/capabilities.ts"
import type { EffortId, ModeId, Outcome } from "../agent/ids.ts"
import type { SettingRow, SettingValue } from "../agent/settings.ts"
import { ModDialogView } from "./mod-dialog.tsx"
import { useModEvents } from "./mod-events.ts"
import { Toast } from "./toast.tsx"
import {
  CliRenderEvents,
  decodePasteBytes,
  type PasteEvent,
  type ScrollBoxRenderable,
  type Selection,
} from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { findModCommand, untitledCommand } from "../input/commands.ts"
import { type Draft, draftFromMessage } from "../input/draft.ts"
import { planReturn } from "../session/plan-mode.ts"
import type { InputProvider } from "../input/provider.ts"
import { log } from "../log/log.ts"
import { within } from "../rewind/common.ts"
import { ContextDialog } from "./context/context-dialog.tsx"
import { UsageDialog } from "./usage/usage-dialog.tsx"
import type { SessionEntry } from "../agent/sessions.ts"
import { currentInfo, currentServers } from "../session/lists.ts"
import {
  type RewindExtras,
  type RewindPreview,
  type RewindRecheck,
  type Rewound,
  rewindPoints,
  shownItems as itemsShown,
} from "../session/rewind.ts"
import {
  controlProblem,
  defaultModeOf,
  effortsOf,
  modelFor,
  modelIds,
  modelRef,
  modeLabel,
  nextMode,
  pickEffort,
  pickModel,
  setControlProblem,
  settings,
  stepEffort,
  stepModel,
  toggleUltracode,
} from "../session/settings.ts"
import { ChoiceDialog } from "./dialog/choice-dialog.tsx"
import { failedSaves, SAVE_PROBLEM } from "../session/settings-file.ts"
import { fileRewindFact, hostFacts, logTail, reportMarkdown, settingsFacts, terminalFacts } from "../report.ts"
import { existsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { writeClipboard } from "../input/clipboard.ts"
import { conversationMarkdown, exportFileName, freeExportName } from "../session/export.ts"
import { skillUses } from "../session/skills.ts"
import { foregroundTasks, runningShellCount, shellNodeId, shellTasks } from "../session/shells.ts"
import type { OneShot, SessionTitle } from "../session/titler.ts"
import type { Ask, ChatImage, Session, SessionInfo, UserMessage } from "../session/types.ts"
import { setTheme, theme } from "../theme/theme.ts"
import { AgentPanel, panelNodes, shownNodes } from "./agents/agent-panel.tsx"
import { AgentView } from "./agents/agent-view.tsx"
import { isAgentCall, isWorkflowCall, messageable, taskIdOf, topNodes } from "./agents/tree.ts"
import { AskSurface, pendingAsk } from "./ask/ask-surface.tsx"
import { held, heldKey, holdKeys, rushedSubmit } from "./ask/typing.ts"
import { useAttention } from "./attention.ts"
import { ChatView, type ScrollState } from "./chat-view.tsx"
import { pasteNotice } from "./chips.ts"
import type { Submission } from "./completion.ts"
import { type CodeRef, CodeView } from "./dialog/code-view.tsx"
import { ImageView } from "./dialog/image-view.tsx"
import { openFile, openUrl } from "./dialog/open-file.ts"
import { modelName, SAVED_NOTICE, windowTitle } from "./format.ts"
import { hasImage, itemImages, labelId, labelTarget } from "./image-label.tsx"
import { messageFolds } from "./markdown/folds.ts"
import { imagesBefore, isImagePath, messageRefs, messageTargets, refId, refTarget } from "./markdown/refs.ts"
import {
  EDGE_GAP,
  MIN_CHAT_ROWS,
  MIN_CHAT_WIDTH,
  overrideFor,
  PANE_MIN_HEIGHT,
  PANE_MIN_WIDTH,
  SIDEBAR_GAP,
  SIDEBAR_MIN_WIDTH,
  sidebarShown,
} from "./layout.ts"
import { matches } from "../mods/keys.ts"
import { clearModNotice, modNotice } from "../mods/mods.ts"
import {
  beforeSend,
  emitModEvent,
  focusedPane,
  guarded,
  modDialog,
  modKeys,
  modPanes,
  paneKeys,
  panePaste,
  type RegisteredPane,
  setAppBridge,
  setAppDialogOpen,
  setAppShown,
  setFocusedPane,
} from "../mods/registry.ts"
import { ModPaneView, setCrowded, shownPane } from "./mod-pane.tsx"
import { modSpan, noticeFor, problemNotice, quitHint, type ReplayInfo, startingNotice } from "./notice.ts"
import { PromptBar, promptInnerWidth } from "./prompt-bar.tsx"
import { useSessionTitle } from "./session-title.ts"
import { ResumeDialog } from "./resume/resume-dialog.tsx"
import { RewindDialog } from "./rewind/rewind-dialog.tsx"
import type { AgentSettings } from "./settings/config-tab.tsx"
import { SettingsDialog, type SettingsTab } from "./settings/settings-dialog.tsx"
import { ThemeDialog } from "./settings/theme-dialog.tsx"
import { relative } from "./tool-call.tsx"
import { ExportDialog } from "./export/export-dialog.tsx"
import { TodoDialog } from "./todos/todo-dialog.tsx"
import { SkillsDialog } from "./skills/skills-dialog.tsx"
import { Sidebar } from "./sidebar.tsx"
import { buildRows } from "./structure.ts"
import { hasThinkingText } from "./thinking.tsx"
import { useElapsedSeconds } from "./elapsed.ts"
import { useTicker } from "./ticker.ts"
import { loadSidebarWidth, saveSidebarWidth } from "./ui-state.ts"
import { RECENT_ROWS, Welcome, welcomeLayout, type Workspace } from "./welcome.tsx"

const QUIT_WINDOW = 2000
// Past this the rewind dialog opens without what the snapshots know.
const PREVIEW_MS = 1000
const NOTE_MS = 4000
const TOAST_MS = 1500
const REPORT_COPIED = "Copied the report · ctrl+o view"
const namesWithCount = (names: string[]) => (names.length > 0 ? `${names.join(", ")} (${names.length})` : null)

// A bare /rename takes up the title Claude Code sets this soon after.
const ADOPT_TITLE_MS = 10_000
const BACKGROUND_HINT_MS = 3000
const NO_LIMITS: Session["usage"]["limits"] = { fiveHour: null, week: null, models: {} }

export type AppProps = {
  session: Session
  // The agent whose session this is.
  agent: Pick<AgentKind, "id" | "name" | "settingChange" | "settingMessage">
  // What the agent can do; the UI leaves out the rest.
  caps: Capabilities
  model: () => string | null
  // Stands in for session.info until the real init arrives.
  firstInfo?: SessionInfo | null
  workspace: Workspace
  replay: ReplayInfo | null
  readOnly?: SessionTitle & { modified: number }
  // A resumed session's listed title, kept until a new message titles it again.
  title?: SessionTitle
  // YellowCode's titler asks it; without it nothing is titled.
  oneShot?: OneShot
  settingsProblem: string | null
  // The archived copy of a broken settings file, opened by a click on the notice.
  settingsBackup?: string | null
  provider: InputProvider
  // Live only; without them the dialogs' actions show a notice.
  extensions?: Pick<Agent, "mcp" | "skills" | "plugins">
  sessions: { list(): Promise<SessionEntry[]>; open(entry: SessionEntry): void }
  earlier?: boolean
  onEarlier?: () => void
  // False when the message could not go out; the prompt keeps it.
  // `giveBack` is called when an accepted message could not go out after all.
  onSubmit: (message: Message, giveBack: () => void) => boolean
  // Enter once Claude Code has exited starts it again and sends what was typed, if anything. Live only.
  onRestart?: (message: Message, giveBack: () => void) => boolean
  onAnswer: (ask: Ask, reply: AskReply) => void
  onQuit: () => void
  // Without it nothing can be interrupted (a replay or a saved conversation).
  onInterrupt?: () => void
  // Runs a `!` command, and stops the one running.
  onShell?: (command: string) => void
  onShellStop?: () => void
  // Without them a stop shows that the conversation is saved (a replay or a saved conversation).
  tasks?: Agent["tasks"]
  // The running agent's model, effort, mode and thinking; none in a replay or a saved conversation.
  knobs?: KnobActions
  // Each new title YellowCode's titler made, so Claude Code can keep it for the session.
  onTitle?: (title: string) => void
  // The running agent's /context, /usage and settings; none in a replay or a saved conversation.
  info?: Pick<Agent, "context" | "usage" | "settings">
  // Without it the session cannot rewind (a read-only transcript). A live rewind puts the files back first and
  // resolves false when the session was not rewound after all, or with the ⚠ that came up since the dialog showed
  // it. `seen` are the ⚠ paths the dialog showed.
  rewind?: {
    preview: RewindPreview
    // Why files are not tracked (null: they are), undefined when not known.
    offReason?: () => string | null | undefined
    onRewind: (rewound: Rewound, seen: string[]) => RewindAnswer | Promise<RewindAnswer>
    onRedo: () => void
    // A rewind or /redo is still putting files back.
    working?: () => boolean
    // A message waits for the conversation to go back.
    goingBack?: () => boolean
  }
}

type RewindAnswer = boolean | RewindRecheck

export type KnobActions = Pick<Agent, "setMode" | "setModel" | "setEffort" | "setExtraEffort" | "setThinking">

// What the user sends; `to` is a running subagent the message is for.
export type Message = Pick<Prompt, "text" | "images" | "to">

type Focus = "input" | "chat" | "panel" | "shells"
type DialogName =
  | { name: "settings"; tab: SettingsTab; row?: string }
  | { name: "resume" | "theme" | "skills" | "export" | "tasks" }
  | { name: "rewind"; extras: RewindExtras | null; late: Promise<RewindExtras | null> | null }
  | { name: "image"; images: ChatImage[]; index: number }
  | { name: "code"; refs: CodeRef[]; ids: string[]; index: number }
  | { name: "choice"; kind: "model" | "effort" }
  | { name: "context" | "usage" }
  // A dialog a mod opened; its request lives in the mod registry.
  | { name: "mod" }

export function App(props: AppProps) {
  const [focus, setFocus] = createSignal<Focus>("input")
  const [listOpen, setListOpen] = createSignal(false)
  const [dialog, setDialog] = createSignal<DialogName | null>(null)
  createEffect(
    on(modDialog, (request) => {
      if (request) setDialog({ name: "mod" })
      else if (dialog()?.name === "mod") setDialog(null)
    }),
  )
  // Another dialog taking the screen closes the mod's.
  createEffect(
    on(dialog, (current) => {
      if (current?.name !== "mod") untrack(modDialog)?.close(null)
    }),
  )
  const settingsTab = () => {
    const open = dialog()
    return open?.name === "settings" ? open.tab : null
  }
  const settingsRow = () => {
    const open = dialog()
    return open?.name === "settings" ? open.row : undefined
  }
  // The agent's own settings, read again each time /settings opens.
  const [agentRows, setAgentRows] = createSignal<SettingRow[] | null>(null)
  const [agentSent, setAgentSent] = createSignal(new Map<string, SettingValue>())
  createEffect(
    on(
      () => settingsTab() !== null,
      (open) => {
        const info = props.info
        if (!open || !info) return
        setAgentRows(null)
        setAgentSent(new Map())
        info.settings
          .rows()
          .then(setAgentRows, (error: unknown) => log.warn("settings for /settings failed", String(error)))
      },
    ),
  )
  const agentSettings = (): AgentSettings | undefined => {
    const info = props.info
    if (!info) return undefined
    return {
      name: props.agent.name,
      rows: agentRows(),
      sent: agentSent(),
      busy: () => props.session.status === "running",
      change: (id, value) =>
        writeSetting(info, id, value).then((done) => {
          if (done.ok) setAgentSent((previous) => new Map(previous).set(id, value))
          return done
        }),
    }
  }
  // An agent that takes its settings as messages gets them the way the user's own messages go out.
  const writeSetting = (info: NonNullable<AppProps["info"]>, id: string, value: SettingValue): Promise<Outcome> => {
    const { name, settingMessage } = props.agent
    if (!settingMessage) return info.settings.write(id, value)
    const text = settingMessage(id, value)
    if (text === null) return Promise.resolve({ ok: false, problem: `${name} has no setting ${id}` })
    const sent = props.onSubmit({ text, images: [], to: null }, () => {})
    return Promise.resolve(sent ? { ok: true, note: null } : { ok: false, problem: `${name} did not take it` })
  }
  const rewindDialog = () => {
    const open = dialog()
    return open?.name === "rewind" && props.rewind ? open : null
  }
  const [fill, setFill] = createSignal<{ draft: Draft; seq: number; ifEmpty?: boolean; insert?: boolean }>()
  // The agent the prompt writes to, set by `m` on an agent.
  const [messageTo, setMessageTo] = createSignal<{ id: string; name: string } | null>(null)
  const [shellMode, setShellMode] = createSignal(false)
  const isTodoRow = (id: string) => {
    const item = props.session.byId[id]
    return item?.kind === "tool" && item.toolKind === "todo"
  }
  const shellRunning = () =>
    props.session.items.some((id) => {
      const item = props.session.byId[id]
      return item?.kind === "tool" && item.local !== undefined && item.status === "running"
    })
  createEffect(
    on(fill, (filled) => {
      if (filled?.draft.to) setMessageTo(filled.draft.to)
    }),
  )
  const [selected, setSelected] = createSignal<string | null>(null)
  // The chat shows its selection only while it has the keys, so coming back starts from the newest item again.
  createEffect(
    on(focus, (now) => {
      if (now !== "chat") setSelected(null)
    }),
  )
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
  // The welcome screen is for a new session only: a /clear starts over in the chat, under a header.
  const welcome = createMemo(() => props.session.items.length === 0 && props.session.conversation === 0)
  const [listed, setListed] = createSignal<SessionEntry[]>([])
  // The session the agent is running is not one to go back to; after a /clear its id comes with the next info.
  const notShown = (entry: SessionEntry) =>
    entry.ref.agent !== props.agent.id || entry.ref.id !== props.session.info?.id
  const unlisted = {
    list: () => props.sessions.list().then((entries) => entries.filter(notShown)),
    open: (entry: SessionEntry) => props.sessions.open(entry),
  }
  const recents = () => listed().filter(notShown).slice(0, RECENT_ROWS)
  // The welcome screen goes when the first item arrives, and the prompt bar takes over what its input held. A mod
  // wrapping the prompt rebuilds it, and it comes back the same way. Read as a member, so each new input gets the latest.
  const heldDraft: { current: Draft | undefined } = { current: undefined }
  // The selected row of the welcome screen's recent sessions; null while the tile has the keys.
  const [recent, setRecent] = createSignal<number | null>(null)
  const loadRecents = () =>
    props.sessions
      .list()
      .then((entries) => setListed(entries.slice(0, RECENT_ROWS + 1)))
      .catch((error: unknown) => log.warn("recent sessions failed to load", String(error)))
  onMount(() => void loadRecents())
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
  // Claude Code's own commands (/model, /clear, /context) name no work unless the user's words follow them; a skill
  // or a custom command carries them, so it is titled.
  const runsBuiltin = (text: string) => untitledCommand(props.provider.commands(), text)
  const haikuTitle = useSessionTitle(
    () => props.session,
    (prompt, cwd) => props.oneShot?.(prompt, cwd) ?? Promise.resolve(null),
    () => props.oneShot !== undefined && settings.sessionTitle === "yellowcode",
    untrack(() => props.readOnly ?? props.title),
    runsBuiltin,
  )
  // A name given with /rename (or the one Claude Code makes for a bare /rename) wins over both sources until a /clear.
  const [renamed, setRenamed] = createSignal<string | null>(null)
  const toAgentTitle = (title: string) => {
    if (props.caps.rename) props.onTitle?.(title)
  }
  let adoptTitleUntil = 0
  createEffect(
    on(
      () => props.session.conversation,
      () => {
        setRenamed(null)
        adoptTitleUntil = 0
      },
      { defer: true },
    ),
  )
  // claude takes a title only once it has said the session's id, which can be after the /rename.
  createEffect(
    on(
      () => [renamed(), props.session.info?.id] as const,
      ([name, id]) => {
        if (name && id) toAgentTitle(name)
      },
    ),
  )
  createEffect(
    on(
      () => props.session.claudeTitle,
      (text) => {
        if (Date.now() > adoptTitleUntil || !text) return
        adoptTitleUntil = 0
        setRenamed(text)
      },
      { defer: true },
    ),
  )
  createEffect(on(haikuTitle, (next) => next && !renamed() && toAgentTitle(next.title), { defer: true }))
  // Claude Code's own title has no summary, so the sidebar shows the first message under it.
  const claudeTitle = () => {
    const text = props.session.claudeTitle
    return text === null ? null : { title: text, summary: "" }
  }
  // A resumed session shows the title it was listed under until claude reports one, or a /clear starts over.
  const listedTitle = untrack(() => props.title) ?? null
  // claude carries a title over into the session a /clear starts, so YellowCode's own source shows only its own.
  const sourceTitle = () =>
    props.readOnly || settings.sessionTitle === "yellowcode"
      ? haikuTitle()
      : (claudeTitle() ?? (props.session.conversation === 0 ? listedTitle : null))
  const title = () => {
    const name = renamed()
    return name ? { title: name, summary: sourceTitle()?.summary ?? "" } : sourceTitle()
  }
  const copyText = (text: string) => writeClipboard(text, (copied) => renderer.copyToClipboardOSC52(copied))
  if (!untrack(() => props.readOnly)) {
    useModEvents(
      renderer,
      () => props.session,
      // From the session's own info, so a model alias resolving to its full name is not a change.
      () => settings.model ?? props.session.info?.model ?? null,
    )
    setAppBridge({
      copy: copyText,
      open: (target) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? openUrl(target) : openFile(target)),
      // After the current key: a mod command inserting text runs before the prompt clears what was sent.
      insert: (text) =>
        queueMicrotask(() =>
          setFill((previous) => ({ draft: { text, chips: [] }, seq: (previous?.seq ?? 0) + 1, insert: true })),
        ),
      session: {
        model: () => settings.model ?? props.model(),
        id: () => props.session.info?.id ?? null,
        running: () => props.session.status === "running",
        permissionMode: () => props.session.permissionMode ?? props.firstInfo?.permissionMode ?? null,
      },
    })
    onMount(() => setAppShown(true))
    // A paste goes to the focused element, the prompt; while a mod's pane has the focus it goes to the pane.
    function pasteToPane(event: PasteEvent): void {
      const pane = focusedPane()
      if (pane === null || dialog()) return
      event.preventDefault()
      event.stopPropagation()
      const sink = panePaste(pane)
      if (sink) guarded(pane.slice(0, pane.indexOf("/")), () => sink(decodePasteBytes(event.bytes)))
    }
    onMount(() => {
      renderer.keyInput.on("paste", pasteToPane)
      onCleanup(() => renderer.keyInput.off("paste", pasteToPane))
    })
    onCleanup(() => {
      setAppBridge(null)
      setAppShown(false)
    })
  }
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
  const narrow = () => dimensions().width < MIN_CHAT_WIDTH + SIDEBAR_MIN_WIDTH
  const [overlay, setOverlay] = createSignal(false)
  createEffect(on(narrow, () => setOverlay(false), { defer: true }))
  const layout = () => sidebarShown(dimensions().width, sidebarWidth(), override(), overlay())
  const shownWidth = () => layout().width
  const sidebar = () => layout().mode
  const besideSidebar = () => dimensions().width - (sidebar() === "docked" ? shownWidth() : 0)
  // A mod's pane, one per position. It never squeezes the chat below its minimum; without room it is not shown.
  const [paneDrag, setPaneDrag] = createSignal<{ pane: RegisteredPane; size: number } | null>(null)
  const paneSize = (pane: RegisteredPane, max: number, min: number) => {
    const drag = paneDrag()
    const size = drag?.pane === pane ? drag.size : pane.size()
    return max < min ? 0 : Math.min(max, Math.max(min, size))
  }
  const rightWidth = () => {
    const pane = shownPane("right")
    const size = pane ? paneSize(pane, besideSidebar() - MIN_CHAT_WIDTH - 1, PANE_MIN_WIDTH) : 0
    return size > 0 ? size + 1 : 0
  }
  const bottomHeight = () => {
    const pane = shownPane("bottom")
    const size = pane ? paneSize(pane, dimensions().height - MIN_CHAT_ROWS - 1, PANE_MIN_HEIGHT) : 0
    return size > 0 ? size + 1 : 0
  }
  const chatWidth = () => besideSidebar() - rightWidth()
  createEffect(() => {
    const placed = new Set([
      bottomHeight() > 0 ? shownPane("bottom")?.key : undefined,
      rightWidth() > 0 ? shownPane("right")?.key : undefined,
    ])
    setCrowded(
      new Set(
        modPanes()
          .filter((pane) => pane.visible() && !placed.has(pane.key))
          .map((pane) => pane.key),
      ),
    )
    const focusedKey = focusedPane()
    if (focusedKey !== null && !placed.has(focusedKey)) setFocusedPane(null)
  })
  const pending = createMemo(() => pendingAsk(props.session))
  // A question from claude counts as a dialog for mods: a mod's dialog closes and new ones resolve as cancelled.
  createEffect(() => setAppDialogOpen(dialog() !== null || pending() !== null))
  createEffect(
    on(pending, (ask) => {
      if (ask) untrack(modDialog)?.close(null)
    }),
  )
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
  createEffect(
    on(pending, (now, before) => {
      // An ask that comes while the hold's limit let typing through to the prompt is held from too.
      // An ask that the user's own interrupt cancelled leaves nothing to hold.
      const withdrawn = before?.status === "cancelled" && !props.session.interrupting
      if (withdrawn || (now && rushedSubmit())) holdKeys(() => pending() !== null)
    }),
  )
  const [mcpFailure, setMcpFailure] = createSignal<string | null>(null)
  const failedServers = new Set<string>()

  createEffect(() => {
    for (const server of props.provider.mcp(props.session.info?.mcpServers ?? null, []) ?? []) {
      if (server.state !== "failed") {
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
  // What was sent from here, by conversation: a /clear takes the chat's user rows, and ↑ still finds them, /clear too.
  const sent: { conversation: number; draft: Draft }[] = []
  const [cleared, setCleared] = createSignal<Draft[]>([])
  createEffect(
    on(
      () => props.session.conversation,
      (conversation) => {
        const done = sent.filter((entry) => entry.conversation < conversation)
        sent.splice(0, done.length)
        setCleared((before) => [...before, ...done.map((entry) => entry.draft)])
        drafts.clear()
        setMessageTo(null)
        setSelected(null)
        setAgentView(null)
        setFocus("input")
      },
      { defer: true },
    ),
  )
  const userDraft = (item: UserMessage, index: number) => {
    const draft = drafts.get(index)
    return draft?.text === item.text ? draft.draft : draftFromMessage(item.text, item.images, item.to ?? undefined)
  }
  // `!` commands are in it too, where they ran.
  const chatHistory = () => {
    let index = -1
    return props.session.items.flatMap((id) => {
      const item = props.session.byId[id]
      if (item?.kind === "tool" && item.local) return [draftFromMessage(`!${item.summary}`, [])]
      if (item?.kind !== "user") return []
      index++
      return [userDraft(item, index)]
    })
  }
  // A message sent after a /clear and still waiting is in both; the history skips repeats in a row.
  const history = () => [...cleared(), ...chatHistory()]

  const lastUser = createMemo(() => {
    for (const id of props.session.items.toReversed()) if (props.session.byId[id]?.kind === "user") return id
    return null
  })
  createEffect(on(lastUser, () => setMcpFailure(null), { defer: true }))

  const [settingsProblem, setSettingsProblem] = createSignal(untrack(() => props.settingsProblem))
  // What claude refused while a settings file problem was in view.
  let waiting: string | null = null
  // What claude refused shows until the next Enter; a broken settings file stays past the Enter that leaves the
  // welcome screen (`previous` is undefined on the first run and null on that Enter).
  const refusalShown = () => settingsProblem() !== null && settingsProblem() === controlProblem()?.text
  createEffect(
    on(lastUser, (_, previous) => {
      if (previous || refusalShown()) setSettingsProblem(null)
    }),
  )
  createEffect(
    on(
      () => [
        settings.theme,
        settings.sidebar,
        settings.thinking,
        settings.sessionTitle,
        defaultModeOf(props.agent.id),
        settings.editor,
        settings.notifications,
      ],
      () => {
        waiting = null
        setSettingsProblem(null)
      },
      { defer: true },
    ),
  )
  createEffect(on(failedSaves, () => setSettingsProblem(SAVE_PROBLEM), { defer: true }))
  // A problem with the settings file stays in view (it may offer the backup); what claude refused meanwhile waits
  // until it has gone.
  const fileProblemShown = () => {
    const shown = settingsProblem()
    return shown !== null && (shown === props.settingsProblem || shown === SAVE_PROBLEM)
  }
  createEffect(
    on(
      controlProblem,
      (problem, previous) => {
        if (problem && fileProblemShown()) waiting = problem.text
        else if (problem) setSettingsProblem(problem.text)
        // Taken back by claude: the refused change came true after all.
        else if (previous && waiting === previous.text) waiting = null
        else if (previous && settingsProblem() === previous.text) setSettingsProblem(null)
      },
      { defer: true },
    ),
  )
  createEffect(
    on(settingsProblem, (shown) => {
      if (shown !== null || waiting === null) return
      const text = waiting
      waiting = null
      setSettingsProblem(text)
    }),
  )

  createEffect(on(() => settings.theme, setTheme, { defer: true }))

  createEffect(() => renderer.setBackgroundColor(theme.canvas))

  // A message's folds and references, worked out again only when its text or its open folds change.
  const imageCounts = createMemo(() =>
    imagesBefore(props.session.items, (id) => {
      const item = props.session.byId[id]
      return item?.kind === "user" ? item.images.length : 0
    }),
  )
  const imagesOf = (id: string) => imageCounts().get(id) ?? 0
  const messageParts = new Map<string, { markdown: string; open: string; images: number; ids: string[] }>()
  const partsOf = (id: string, markdown: string) => {
    const open = Object.keys(expanded)
      .filter((key) => expanded[key] === true && key.startsWith(`${id}/fold/`))
      .join()
    const known = messageParts.get(id)
    const images = imagesOf(id)
    if (known?.markdown === markdown && known.open === open && known.images === images) return known.ids
    const ids = [...messageFolds(markdown, id, expanded), ...messageRefs(markdown, id, process.cwd(), images, expanded)]
    messageParts.set(id, { markdown, open, images, ids })
    return ids
  }
  const shownItems = () => itemsShown(props.session.items, props.session.rewound)
  const rows = createMemo(() => buildRows(props.session))
  // The rows' items in order: a hidden thought gives none, a group its own id and, while open, its calls and thoughts.
  const rowItems = () =>
    rows().flatMap((row) => {
      if (row.kind === "group") return [row.id].concat(expanded[row.id] === true ? row.members : [])
      return row.kind === "end" || row.kind === "rewound" ? [] : [row.id]
    })
  const selectableIds = () =>
    rowItems().flatMap((id) => {
      if (id.endsWith("/group")) return [id]
      const item = props.session.byId[id]
      const own =
        item?.kind === "tool" || (item?.kind === "thinking" && hasThinkingText(item)) || overflowing[id] === true
          ? [id]
          : []
      const parts = item?.kind === "text" ? partsOf(id, item.markdown) : []
      const labels = itemImages(item, process.cwd()).flatMap((image, index) =>
        hasImage(image) ? [labelId(id, index)] : [],
      )
      return own.concat(parts, labels)
    })

  // The image a `[Image N]` mention points at: image N of the latest user message before it that has one.
  const mentionedImages = (itemId: string, n: number) => {
    if (n < 1) return null
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
    const all = messageTargets(item.markdown, process.cwd(), imagesOf(target.itemId))
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
  const choiceKind = () => {
    const open = dialog()
    return open?.name === "choice" ? open.kind : null
  }
  // A pick goes to the agent only when it changed what the knobs show.
  const toModel = (id: string | null) => {
    if (id !== null) void props.knobs?.setModel(modelRef(id))
  }
  // The levels of the model the session uses.
  const efforts = () => effortsOf(props.provider.models(), settings.model ?? props.model())
  const toEffort = (level: EffortId | null) => {
    if (level !== null && props.caps.effort) void props.knobs?.setEffort(level)
  }
  // The Config tab saves these; the running session takes them too.
  createEffect(
    on(
      () => settings.thinking,
      (thinking) => {
        if (props.caps.thinking) void props.knobs?.setThinking(thinking !== "hidden")
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => defaultModeOf(props.agent.id),
      (mode) => void props.knobs?.setMode(mode),
      { defer: true },
    ),
  )
  // /model and /effort with a value YellowCode knows pick it here; any other value goes on to Claude Code.
  const typedKnob = (name: string, value: string): boolean => {
    if (!props.knobs || (name !== "model" && name !== "effort")) return false
    if (name === "effort" && !props.caps.effort) return false
    // A model without effort levels: Claude Code's own /effort says so.
    if (name === "effort" && settings.effort === null) return false
    if (!value) {
      setDialog({ name: "choice", kind: name })
      return true
    }
    if (name === "model") {
      const id = modelFor(value)
      if (id) toModel(pickModel(id))
      return id !== null
    }
    const level = efforts().find((known) => known.id === value.toLowerCase())
    if (level) toEffort(pickEffort(level.id))
    return level !== undefined
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
    if (!label || !hasImage(label)) return
    // A missing file has nothing to show, so the view skips it.
    const images = all.filter(hasImage)
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
    const top = topNodes(props.session)
    const target = top.findLast((node) => node.state === "running") ?? top.at(-1)
    if (target) openAgentView(target.id)
    else openShells()
  }

  const shellCount = createMemo(() => runningShellCount(props.session))
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
  const panelShown = () => shownNodes(panel(), focus() === "panel" ? panelPick() : null)
  const panelIds = () => panelShown().map((node) => node.id)
  const docked = createMemo(() => new Set(panelShown().flatMap((node) => (node.state === "running" ? [node.id] : []))))
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
  const takesMessages = () => props.caps.features.includes("agentMessages")
  // Starts a message to an agent, or says why it cannot be. Both the panel and the agent view come here.
  const startMessage = (id: string): string | null => {
    if (!takesMessages()) return null
    const tool = props.session.byId[id]
    const node = topNodes(props.session).find((entry) => entry.id === id)
    if (!node || node.kind !== "agent" || tool?.kind !== "tool") return null
    if (!live()) return SAVED_NOTICE
    if (!messageable(props.session, node)) return `${node.name} was stopped; it cannot take messages`
    const taskId = taskIdOf(props.session, node)
    if (!taskId) return null
    setMessageTo({ id: taskId, name: node.name })
    setAgentView(null)
    setFocus("input")
    return null
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
    else if (name === "return") {
      const id = panelSelected()
      if (id) openFromPanel(id)
    }
  }

  const jumpDown = () => scroll?.scrollTo(scroll.scrollHeight)

  const moveSelection = (step: 1 | -1) => {
    const ids = selectableIds()
    if (ids.length === 0) return
    const current = ids.indexOf(selected() ?? "")
    const next = current === -1 ? ids.length - 1 : Math.min(ids.length - 1, Math.max(0, current + step))
    setSelected(ids[next] ?? null)
  }

  const interruptible = () =>
    props.onInterrupt !== undefined && props.session.turn !== null && !props.session.interrupting
  // The hint waits until a foreground command or agent has run a few seconds. Claude Code reports a command as a task
  // only about that long after it starts, so a shell shows the hint as soon as it is a task.
  const foreground = () => (props.caps.backgroundNow ? foregroundTasks(props.session) : [])
  const backgroundTick = useTicker(() => foreground().length > 0, 500)
  const backgroundable = () => {
    backgroundTick()
    const now = Date.now()
    return foreground().some(
      (task) => task.type === "local_bash" || (task.startedAt !== null && now - task.startedAt >= BACKGROUND_HINT_MS),
    )
  }
  // Ctrl+C interrupts once per turn, so a claude that refuses the interrupt can still be quit; Esc can try again.
  let interruptedByCtrlC = false
  createEffect(
    on(
      () => props.session.turn,
      (turn) => {
        if (turn === null) interruptedByCtrlC = false
      },
    ),
  )

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
    props.rewind !== undefined &&
    props.session.status !== "running" &&
    !pending() &&
    shownItems().some((id) => props.session.byId[id]?.kind === "user")
  const [rewindNote, setRewindNote] = createSignal<string | null>(null)
  let clearRewindNote: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(clearRewindNote))
  let previewing = false
  // No rewind while a turn runs, one claude started by itself included.
  const exportText = () =>
    conversationMarkdown(props.session, {
      title: title()?.title || "Conversation",
      model: modelName(settings.model ?? props.model() ?? ""),
      cwd: process.cwd(),
      date: new Date(),
    })
  const exportTo = async (name: string, replace: boolean) => {
    setDialog(null)
    const path = resolve(process.cwd(), name)
    if (!replace && existsSync(path)) return waitNotice(`${name} exists, nothing saved`)
    try {
      await Bun.write(path, exportText())
      waitNotice(`Exported to ${relative(process.cwd(), path)}`)
    } catch (error) {
      waitNotice(`Could not save ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const exportToClipboard = async () => {
    setDialog(null)
    const copied = await copyText(exportText())
    waitNotice(copied ? "Conversation copied" : "Could not copy the conversation")
  }
  // ctrl+o shows the copied report while its notice is up.
  let copiedReport = ""
  const copyReport = async () => {
    const info = currentInfo(props.session, props.firstInfo ?? null)
    const servers = currentServers(props.session, props.firstInfo ?? null) ?? []
    const plugins = info ? props.provider.plugins(info) : []
    const mode = props.session.permissionMode ?? props.firstInfo?.permissionMode ?? null
    const text = reportMarkdown({
      environment: [...hostFacts(info?.cliVersion ?? null), ...terminalFacts(renderer.capabilities)],
      settings: settingsFacts(settings, props.agent.id, props.provider.modes(), settingsProblem()),
      session: [
        ["Model", modelName(settings.model ?? props.model() ?? "")],
        ["Effort", settings.effort],
        ["Permission mode", mode === null ? null : modeLabel(props.provider.modes(), mode)],
        ["Skills", String(props.provider.skills()?.length ?? 0)],
        ["Tools", info ? String(info.tools.length) : null],
        ["File rewind", fileRewindFact(props.rewind?.offReason?.())],
      ],
      extensions: [
        ["MCP", namesWithCount(servers.map((server) => server.name))],
        ["Plugins", namesWithCount(plugins.map((plugin) => plugin.name))],
      ],
      log: logTail(50),
    })
    const copied = await copyText(text)
    copiedReport = copied ? text : ""
    waitNotice(copied ? REPORT_COPIED : "Could not copy the report")
  }
  const busy = () =>
    props.rewind !== undefined && props.replay === null && !props.readOnly && props.session.status === "running"
  const waitNotice = (text = "Rewind waits until Claude Code is idle") => {
    setRewindNote(text)
    clearTimeout(clearRewindNote)
    clearRewindNote = setTimeout(() => setRewindNote(null), NOTE_MS)
  }
  const [toast, setToast] = createSignal<string | null>(null)
  let clearToast: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(clearToast))
  const copySelection = (selection: Selection) => {
    const text = selection.getSelectedText()
    if (!text.trim()) return
    void copyText(text).then((copied) => {
      if (!copied) return waitNotice("Could not copy the selection")
      setToast("Copied")
      clearTimeout(clearToast)
      clearToast = setTimeout(() => setToast(null), TOAST_MS)
    })
  }
  renderer.on(CliRenderEvents.SELECTION, copySelection)
  onCleanup(() => renderer.off(CliRenderEvents.SELECTION, copySelection))
  createEffect(
    on(busy, (running) => {
      if (!running || untrack(dialog)?.name !== "rewind") return
      setDialog(null)
      waitNotice()
    }),
  )
  // Where the chat was when the timeline opened; Esc goes back there.
  let timelineFrom: number | null = null
  const openTimeline = (extras: RewindExtras | null, late: Promise<RewindExtras | null> | null) => {
    timelineFrom = scroll?.scrollTop ?? null
    setDialog({ name: "rewind", extras, late })
  }
  const closeTimeline = () => {
    if (timelineFrom !== null) scroll?.scrollTo(timelineFrom)
    timelineFrom = null
    setDialog(null)
  }
  const openRewind = async () => {
    setRewindArmed(false)
    const rewind = props.rewind
    const prompts = shownItems().some((id) => props.session.byId[id]?.kind === "user")
    if (rewind && !prompts) return waitNotice("Nothing to rewind")
    if (!rewind || pending() || previewing || dialog() !== null) return
    // While Claude Code works the list still opens; only rewinding waits.
    if (busy() || rewind.working?.() || !canRewind()) return openTimeline(null, null)
    previewing = true
    // The dialog opens on the newest prompt an earlier rewind did not hide.
    const users = userItems()
    const hidden = users.findIndex((item) => item?.id === props.session.rewound?.userId)
    const newest = (hidden === -1 ? users.length : hidden) - 1
    const working = rewind.preview(props.session, newest).catch((error: unknown) => {
      log.warn("rewind preview failed", String(error))
      return null
    })
    const extras = await within(working, PREVIEW_MS).finally(() => {
      previewing = false
    })
    if (extras === undefined) log.warn("rewind preview too slow", { ms: PREVIEW_MS })
    // Something may have opened while the preview was worked out.
    if (dialog() === null) openTimeline(extras ?? null, extras === undefined ? working : null)
  }
  const pressEscape = () => {
    if (shellRunning()) {
      props.onShellStop?.()
      return
    }
    if (shellMode()) {
      setShellMode(false)
      return
    }
    if (messageTo()) {
      setMessageTo(null)
      return
    }
    if (!canRewind()) return
    if (rewindArmed()) {
      void openRewind()
      return
    }
    setRewindArmed(true)
    clearTimeout(disarmRewind)
    disarmRewind = setTimeout(() => setRewindArmed(false), QUIT_WINDOW)
  }
  onCleanup(() => clearTimeout(disarmRewind))
  const rewind = async (rewound: Rewound, seen: string[]): Promise<RewindRecheck | null> => {
    if (busy()) {
      waitNotice()
      return null
    }
    if (props.rewind?.working?.()) {
      waitNotice("Rewind waits until the files are back")
      return null
    }
    timelineFrom = null
    const index = userItems().findIndex((item) => item.id === rewound.userId)
    const user = userItems()[index]
    const draft = user ? userDraft(user, index) : undefined
    const answer = await props.rewind?.onRewind(rewound, seen)
    // Typed meanwhile, the draft stays.
    if (draft && answer === true) setFill((previous) => ({ draft, seq: (previous?.seq ?? 0) + 1, ifEmpty: true }))
    return typeof answer === "object" ? answer : null
  }
  const redo = () => {
    if (!props.session.rewound) return waitNotice("Nothing to redo")
    props.rewind?.onRedo()
  }

  // Registered before any ask view mounts, so stopPropagation keeps these keys from an open ask.
  useKeyboard((key) => {
    // Only two Escapes in a row open the rewind; any other key in between starts over.
    if (key.name !== "escape") setRewindArmed(false)
    if (heldKey(key)) {
      key.preventDefault()
      key.stopPropagation()
      return
    }
    // A focused mod pane takes every key but the shortcuts mods registered, even while claude asks something: keys
    // typed for the pane must not answer the ask. Ctrl+], a click on the chat or the pane's own key leaves it.
    const pane = focusedPane()
    if (pane !== null && !dialog()) {
      key.preventDefault()
      key.stopPropagation()
      if (key.ctrl && key.name === "]") {
        setFocusedPane(null)
        return
      }
      const owner = pane.slice(0, pane.indexOf("/"))
      const shortcut = modKeys().find(
        (entry) => (entry.when !== "pane" || entry.mod === owner) && matches(entry.binding, key),
      )
      if (shortcut) shortcut.run()
      else {
        const sink = paneKeys(pane)
        if (sink) guarded(owner, () => sink(key))
      }
      return
    }
    if (key.ctrl && key.name === "c" && shellRunning()) {
      key.preventDefault()
      key.stopPropagation()
      props.onShellStop?.()
      return
    }
    if (key.ctrl && key.name === "c") {
      // A turn the user started is interrupted first, whatever is open; the draft stays. A turn claude started on its
      // own (Esc interrupts it) is not what the user meant to stop, so Ctrl+C clears or quits there.
      if (interruptible() && props.session.turn === "user" && !interruptedByCtrlC) {
        interruptedByCtrlC = true
        key.preventDefault()
        key.stopPropagation()
        props.onInterrupt?.()
        return
      }
      // A focused prompt takes it: it clears its text, or calls pressQuit when empty.
      if (input().focused && !pending()) return
      key.stopPropagation()
      pressQuit()
      return
    }
    if (key.ctrl && key.name === "b" && foreground().length > 0) {
      key.preventDefault()
      key.stopPropagation()
      void props.tasks?.background().then((done) => {
        if (!done.ok) setControlProblem({ text: done.problem })
      })
      return
    }
    if (dialog()) return
    const modKey = modKeys().find((entry) => entry.when !== "pane" && matches(entry.binding, key))
    if (modKey) {
      key.preventDefault()
      key.stopPropagation()
      modKey.run()
      return
    }
    if (key.ctrl && key.name === "o" && copiedReport && rewindNote() === REPORT_COPIED) {
      key.preventDefault()
      key.stopPropagation()
      setDialog({ name: "code", refs: [{ path: "report.md", text: copiedReport }], ids: [], index: 0 })
      return
    }
    if (key.ctrl && key.name === "t") {
      key.preventDefault()
      key.stopPropagation()
      // The welcome screen has no agent view.
      if (!pending() && !welcome()) toggleAgentView()
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
      if (welcome()) return
      if (narrow()) setOverlay(!overlay())
      else setOverride(sidebar() === "hidden" ? "open" : "closed")
      return
    }
    if (sidebar() === "overlay" && (key.name === "escape" || key.sequence.startsWith("\x1b\x1b"))) {
      key.preventDefault()
      key.stopPropagation()
      setOverlay(false)
      return
    }
    if (pending()) return
    // An Esc read together with the next sequence (a second Esc, a focus or mouse report) parses as one meta key.
    if (
      (focus() === "panel" || focus() === "shells") &&
      (key.name === "escape" || key.sequence.startsWith("\x1b\x1b"))
    ) {
      key.preventDefault()
      key.stopPropagation()
      setFocus("input")
      return
    }
    if (focus() === "panel" && !key.ctrl && !key.meta && !key.shift && key.name === "m") {
      key.preventDefault()
      key.stopPropagation()
      const id = panelSelected()
      const why = id ? startMessage(id) : null
      if (why) waitNotice(why)
      return
    }
    if (
      focus() === "panel" &&
      !key.ctrl &&
      !key.meta &&
      !key.shift &&
      (key.name === "up" || key.name === "down" || key.name === "return")
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
      (key.name === "up" || key.name === "down" || key.name === "return")
    ) {
      key.preventDefault()
      key.stopPropagation()
      if (key.name === "down") enterPanel()
      else if (key.name === "return") openShells()
      else setFocus("input")
      return
    }
    // Esc interrupts only when nothing else takes it; the draft stays.
    if (key.name === "escape" && !listOpen() && interruptible()) {
      key.preventDefault()
      key.stopPropagation()
      props.onInterrupt?.()
      return
    }
    // With Claude Code gone there is nothing to change.
    const knob = (key.shift && ["up", "down", "left", "right"].includes(key.name)) || key.name === "f4"
    if (knob && ended()) {
      key.preventDefault()
      return
    }
    if (key.shift && (key.name === "up" || key.name === "down")) {
      key.preventDefault()
      if (props.caps.effort)
        toEffort(
          stepEffort(
            efforts().map((level) => level.id),
            key.name === "up" ? 1 : -1,
          ),
        )
      return
    }
    if (key.shift && (key.name === "left" || key.name === "right")) {
      key.preventDefault()
      toModel(stepModel(key.name === "right" ? 1 : -1, props.model()))
      return
    }
    if (key.name === "f4") {
      if (!props.caps.extraEffort) return
      const ultracode = toggleUltracode()
      void props.knobs?.setExtraEffort(ultracode)
      return
    }
    if (key.name === "end" && !welcome() && !scrollState().atBottom) {
      key.preventDefault()
      jumpDown()
      return
    }
    if (key.name === "tab" && key.shift) {
      key.preventDefault()
      const next = nextMode(props.provider.modes(), props.session.permissionMode)
      if (props.knobs && !ended() && next !== null) chooseMode(next)
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
    // Esc gives the keys back to the prompt.
    if (key.name === "escape") {
      key.preventDefault()
      setFocus("input")
      return
    }
    if (key.name === "up") moveSelection(-1)
    else if (key.name === "down") moveSelection(1)
    else if (key.name === "return") {
      const id = selected()
      if (id && labelTarget(id)) openImage(id)
      else if (id && refTarget(id)) openRef(id)
      else if (id && isAgentRow(id)) setAgentView(id)
      else if (id && isTodoRow(id)) setDialog({ name: "tasks" })
      else if (id) toggle(id)
    }
  })

  const live = () => props.replay === null && !props.readOnly
  const ended = () => live() && props.session.status === "ended"

  const planBack = planReturn()
  createEffect(
    on(
      () => props.session.permissionMode,
      (mode) => {
        const target = mode ? planBack.seen(mode, props.provider.modes()) : null
        if (target) void props.knobs?.setMode(target)
      },
    ),
  )
  const chooseMode = (mode: ModeId) => {
    planBack.cancel()
    void props.knobs?.setMode(mode)
  }
  const planMode = () => {
    const plan = props.provider.modes().find((mode) => mode.kind === "plan")
    if (props.knobs && plan) chooseMode(plan.id)
  }

  const submit = ({ text, images, draft }: Submission): boolean => {
    if (rushedSubmit()) return false
    clearModNotice()
    const to = messageTo()
    const command = to ? "" : text.trim()
    if (to && images.length > 0) {
      waitNotice("Images cannot go to an agent")
      return false
    }
    if (to && !text.trim()) return false
    if (!to && (shellMode() || command.startsWith("!"))) {
      const line = shellMode() ? text.trim() : command.slice(1).trim()
      if (!line) return false
      if (!props.onShell) {
        waitNotice(SAVED_NOTICE)
        return false
      }
      if (shellRunning()) {
        waitNotice("A shell command is still running · Esc stops it")
        return false
      }
      setShellMode(false)
      // The input clears first: the row the command adds closes the welcome screen, which hands its text on.
      const run = props.onShell
      queueMicrotask(() => run(line))
      jumpDown()
      sent.push({ conversation: props.session.conversation, draft: { ...draft, text: `!${line}` } })
      return true
    }
    const [, commandName = "", commandArgs = ""] = /^\/(\S+)\s*([\s\S]*)$/.exec(command) ?? []
    if (props.provider.blocked(commandName)) {
      waitNotice("Not available in YellowCode")
      return false
    }
    if (typedKnob(commandName, commandArgs.trim())) return true
    if (commandName === "rename" && props.onTitle && props.caps.rename) {
      const name = commandArgs.trim()
      if (name) {
        setRenamed(name)
        return true
      }
      // Claude Code makes the name; its title change brings it here.
      adoptTitleUntil = Date.now() + ADOPT_TITLE_MS
    }
    if (command === "/reload-skills" && props.extensions && props.caps.skills.reload) {
      void props.extensions.skills
        .reload()
        .then((done) =>
          waitNotice(done.ok ? (done.note ?? "Skills reloaded") : `Could not reload the skills: ${done.problem}`),
        )
      return true
    }
    // Bare, a command with a setting opens its row in /settings; with a value it goes to the agent as typed.
    const setting = command === `/${commandName}` ? props.provider.setting(commandName) : null
    if (setting && props.info) {
      setDialog({ name: "settings", tab: "config", row: `agent:${setting}` })
      return true
    }
    const report =
      command === "/context" ? props.caps.context !== "none" : command === "/usage" && props.caps.usageReport
    if (report && props.info) {
      setDialog({ name: command === "/context" ? "context" : "usage" })
      return true
    }
    const rewinding = command === "/rewind" || command === "/timeline" || command === "/redo"
    const planning = command === "/plan" || command.startsWith("/plan ")
    if ((rewinding && !props.rewind) || (planning && !props.onInterrupt)) {
      waitNotice(SAVED_NOTICE)
      return false
    }
    const [, typed = "", args = ""] = /^\/(\S+)\s*([\s\S]*)$/.exec(command) ?? []
    const modCommand = typed ? findModCommand(props.provider.commands(), typed) : undefined
    if (modCommand) {
      void modCommand.run(args.trim())
      return true
    }
    if (command === "/report") void copyReport()
    else if (command === "/settings") setDialog({ name: "settings", tab: "config" })
    else if (command === "/resume") setDialog({ name: "resume" })
    else if (command === "/theme") setDialog({ name: "theme" })
    else if (command === "/mcp") setDialog({ name: "settings", tab: "mcp" })
    else if (command === "/plugins") setDialog({ name: "settings", tab: "plugins" })
    else if (command === "/skills") setDialog({ name: "skills" })
    else if (command === "/mods") setDialog({ name: "settings", tab: "mods" })
    else if (command === "/rewind" || command === "/timeline") void openRewind()
    else if (command === "/redo") redo()
    else if (command === "/export") setDialog({ name: "export" })
    else if (command === "/plan") planMode()
    else if (command.startsWith("/export ")) void exportTo(command.slice("/export ".length).trim(), false)
    else {
      // Mods see what the user typed, not the commands Claude Code runs.
      const message = text.trim() !== "" && !text.trim().startsWith("/")
      const changed = message ? beforeSend(text) : text
      if (changed === null) {
        waitNotice("A mod stopped this message")
        return false
      }
      const planned = command.startsWith("/plan ") ? command.slice("/plan ".length).trim() : null
      // The mode changes before the message goes out, so the message runs in it; a refused send puts it back,
      // except a default-kind mode, which stays in plan.
      const modeBefore = props.provider
        .modes()
        .find((mode) => mode.id === props.session.permissionMode && mode.kind !== "default")?.id
      if (planned !== null) planMode()
      const index = userItems().length
      // A message that cannot go out comes back to the prompt, unless something else was typed there meanwhile.
      const giveBack = () => setFill((previous) => ({ draft, seq: (previous?.seq ?? 0) + 1, ifEmpty: true }))
      const out: Message = to
        ? { text: changed, images, to: { task: to.id, name: to.name } }
        : { text: planned ?? changed, images, to: null }
      const kept = to ? { ...draft, to } : draft
      const back = to
        ? () => setFill((previous) => ({ draft: kept, seq: (previous?.seq ?? 0) + 1, ifEmpty: true }))
        : giveBack
      const accepted = ended() ? (props.onRestart?.(out, back) ?? false) : props.onSubmit(out, back)
      if (!accepted) {
        if (planned !== null && modeBefore) chooseMode(modeBefore)
        return false
      }
      if (message) emitModEvent("message-sent", { text: changed })
      jumpDown()
      if (to) setMessageTo(null)
      if (draft.chips.length > 0) drafts.set(index, { text, draft })
      // An empty Enter (a restart, a replay's next message) leaves nothing to recall.
      if (text.trim() || images.length > 0) sent.push({ conversation: props.session.conversation, draft: kept })
    }
    return true
  }

  const input = () => ({
    focused:
      focus() === "input" && dialog() === null && recent() === null && agentView() === null && focusedPane() === null,
    messageTo: messageTo(),
    shell: shellMode(),
    permissionMode: props.onInterrupt ? props.session.permissionMode : null,
    onBang: () => {
      if (messageTo() || !props.onShell) return false
      setShellMode(true)
      return true
    },
    onBackspaceEmpty: () => {
      if (shellMode()) {
        setShellMode(false)
        return true
      }
      if (!messageTo()) return false
      setMessageTo(null)
      return true
    },
    onRecall: setMessageTo,
    placeholder: shellMode()
      ? "Run a shell command"
      : messageTo()
        ? `Message @${messageTo()?.name}…`
        : props.readOnly
          ? "Read-only · a saved conversation"
          : props.replay
            ? "Enter sends the next recorded message"
            : ended()
              ? props.onRestart
                ? "Claude Code is not running · Enter restarts it"
                : "Claude Code is not running"
              : "Message Claude Code",
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
            width={promptInnerWidth(chatWidth())}
            caps={props.caps}
            onAnswer={props.onAnswer}
            onPlanApproved={() => planBack.approve()}
            onOpenImages={(images, index) => setDialog({ name: "image", images, index })}
            onOpenScript={(name, script) =>
              setDialog({ name: "code", refs: [{ path: `${name}.js`, text: script }], ids: [], index: 0 })
            }
          />
        )
      },
    ),
  )

  const welcomeNotice = () => {
    if (quitArmed()) return quitHint()
    const problem = pasteNotice() ?? settingsProblem()
    if (problem) return problemNotice(problem)
    const mod = modNotice()
    if (mod) return modSpan(mod)
    const note = rewindNote()
    if (note) return { text: note, fg: theme.muted }
    if (ended()) {
      const restart = props.onRestart ? " · Enter: restart" : ""
      return { text: `✗ Claude Code exited · Ctrl+C: quit${restart}`, fg: theme.error }
    }
    return live() && props.session.status === "starting" ? startingNotice() : null
  }
  const openBackup = () => {
    const backup = props.settingsBackup
    if (!backup || quitArmed() || pasteNotice() || settingsProblem() !== props.settingsProblem) return undefined
    return () => void openFile(backup)
  }

  const clock = useTicker(() => props.session.usage.warning !== null, 30_000)
  const compactingFor = useElapsedSeconds(() => props.session.compacting)
  // Armed quit and rewind hints sit on the notice row, so the pill gives way to them.
  const newLines = () => {
    const { atBottom, newLines: lines } = scrollState()
    if (atBottom || lines === 0 || quitArmed() || rewindArmed() || rewindNote()) return undefined
    return { lines, onClick: jumpDown }
  }
  const notice = () => {
    clock()
    return noticeFor({
      usage: props.session.usage,
      replay: props.replay,
      readOnly: props.readOnly?.title ?? null,
      status: props.session.status,
      restartable: props.onRestart !== undefined,
      mcpFailure: mcpFailure(),
      settingsProblem: pasteNotice() ?? settingsProblem(),
      mod: modNotice(),
      asking: pending() !== null,
      compacting: props.session.compacting ? compactingFor() : null,
      goingBack: props.rewind?.goingBack?.() ?? false,
      quitArmed: quitArmed(),
      rewindArmed: rewindArmed(),
      note: rewindNote(),
      held: held(),
      interruptible: interruptible(),
      backgroundable: backgroundable(),
      modes: props.onInterrupt !== undefined,
      extraEffort: props.caps.extraEffort,
      limits: props.caps.limits,
      now: Date.now(),
    })
  }

  // A drag that started on a pane's edge; false when none is going on.
  const movePane = (event: { x: number; y: number }) => {
    const drag = paneDrag()
    if (!drag) return false
    const size = drag.pane.position() === "bottom" ? dimensions().height - event.y - 1 : besideSidebar() - event.x - 1
    setPaneDrag({ pane: drag.pane, size })
    return true
  }
  const endPaneDrag = () => {
    const drag = paneDrag()
    if (!drag) return false
    // The size the pane shows at the end of the drag, kept within its limits.
    const size = drag.pane.position() === "bottom" ? bottomHeight() - 1 : rightWidth() - 1
    setPaneDrag(null)
    if (size > 0) guarded(drag.pane.mod, () => drag.pane.onResize?.(size))
    return true
  }
  const BottomPane = (paneProps: { width: number }) => (
    <Show when={bottomHeight() > 0 ? shownPane("bottom") : undefined} keyed>
      {(pane) => (
        <ModPaneView
          pane={pane}
          width={paneProps.width}
          height={bottomHeight()}
          onResizeStart={() => setPaneDrag({ pane, size: bottomHeight() - 1 })}
        />
      )}
    </Show>
  )
  const RightPane = () => (
    <Show when={rightWidth() > 0 ? shownPane("right") : undefined} keyed>
      {(pane) => (
        <ModPaneView
          pane={pane}
          width={rightWidth()}
          height={dimensions().height}
          onResizeStart={() => setPaneDrag({ pane, size: rightWidth() - 1 })}
        />
      )}
    </Show>
  )

  return (
    <box flexDirection="column" flexGrow={1}>
      <Show
        when={!welcome()}
        fallback={
          <box
            flexDirection="row"
            flexGrow={1}
            onMouseDrag={(event) => void movePane(event)}
            onMouseUp={() => void endPaneDrag()}
          >
            <box
              flexDirection="column"
              width={dimensions().width - rightWidth()}
              onMouseDown={() => setFocusedPane(null)}
            >
              <Welcome
                input={{
                  ...input(),
                  onLeaveDown: () => {
                    if (recentShown()) setRecent(0)
                  },
                  onDraft: (next) => (heldDraft.current = next),
                  draft: heldDraft.current,
                  history,
                }}
                workspace={props.workspace}
                notice={welcomeNotice()}
                onNotice={openBackup()}
                recent={{ entries: recents(), selected: recent() }}
                width={dimensions().width - rightWidth()}
                height={dimensions().height - bottomHeight()}
              />
              <BottomPane width={dimensions().width - rightWidth()} />
            </box>
            <RightPane />
          </box>
        }
      >
        <Show when={agentView()}>
          {(id) => (
            <AgentView
              session={props.session}
              selected={id()}
              onSelect={setAgentView}
              onClose={() => setAgentView(null)}
              tasks={props.tasks}
              canStop={props.caps.stopTask}
              onMessage={takesMessages() ? startMessage : undefined}
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
            if (movePane(event)) return
            if (!resizing() || event.isDragging) return
            const width = dimensions().width
            const half = Math.floor(width / 2)
            const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(half, width - MIN_CHAT_WIDTH))
            const gap = sidebar() === "docked" ? SIDEBAR_GAP : 0
            setSidebarWidth(Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, width - event.x + gap)))
          }}
          onMouseUp={() => {
            if (endPaneDrag()) return
            if (!resizing()) return
            setResizing(false)
            saveSidebarWidth(sidebarWidth())
          }}
        >
          <box flexDirection="column" width={chatWidth()} onMouseDown={() => setFocusedPane(null)}>
            <ChatView
              session={props.session}
              workspace={props.workspace}
              model={settings.model ?? props.model()}
              commands={props.provider.commands()}
              settingChange={props.agent.settingChange}
              width={chatWidth()}
              selected={focus() === "chat" ? selected() : null}
              expanded={expanded}
              onOverflow={(id, value) => setOverflowing(id, value)}
              onToggle={(id) => setExpanded(id, (open) => !open)}
              onOpenAgent={openAgentView}
              onOpenImage={openImage}
              onOpenRef={openRef}
              docked={(id) => docked().has(id)}
              imagesBefore={imagesOf}
              earlier={props.earlier ?? false}
              onReachTop={() => props.onEarlier?.()}
              onScrollState={setScrollState}
              scrollRef={(element) => (scroll = element)}
              onRedo={redo}
            />
            <PromptBar
              {...input()}
              draft={heldDraft.current}
              onDraft={(next) => (heldDraft.current = next)}
              spaced
              width={chatWidth()}
              notice={notice()}
              newLines={newLines()}
              context={props.session.usage.context}
              ask={askView()}
              history={history}
              onListOpen={setListOpen}
              onLeaveDown={() => (shellCount() > 0 ? setFocus("shells") : enterPanel())}
              agents={panel().length > 0}
              shells={{ count: shellCount(), selected: focus() === "shells", onOpen: openShells }}
            />
            <Show when={panel().length > 0}>
              {/* The selection bar sits in the last gap cell, so the marks line up with the prompt. */}
              <box paddingLeft={EDGE_GAP - 1} flexShrink={0}>
                <AgentPanel
                  nodes={panel()}
                  selected={panelSelected()}
                  width={chatWidth() - 2 * EDGE_GAP + 1}
                  onOpen={openFromPanel}
                  canMessage={(() => {
                    const node = panel().find((entry) => entry.id === panelSelected())
                    return takesMessages() && node !== undefined && messageable(props.session, node)
                  })()}
                />
              </box>
            </Show>
            <BottomPane width={chatWidth()} />
            <Show when={toast()}>{(text) => <Toast text={text()} width={chatWidth()} />}</Show>
          </box>
          <RightPane />
          <Show when={sidebar() !== "hidden"}>
            <Sidebar
              session={props.session}
              title={title()}
              workspace={props.workspace}
              modified={props.readOnly?.modified}
              model={settings.model ?? props.model()}
              servers={props.provider.mcp(currentServers(props.session, null), props.session.info?.tools ?? [])}
              caps={props.caps}
              width={shownWidth()}
              overlay={sidebar() === "overlay"}
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
            info={currentInfo(props.session, props.firstInfo ?? null)}
            servers={currentServers(props.session, props.firstInfo ?? null)}
            extensions={props.extensions}
            caps={props.caps}
            permissionMode={props.session.permissionMode ?? props.firstInfo?.permissionMode ?? null}
            title={title()?.title ?? null}
            model={settings.model ?? props.model()}
            version={props.workspace.version}
            provider={props.provider}
            row={settingsRow()}
            agent={props.agent.id}
            agentSettings={agentSettings()}
            onTab={(next) => setDialog({ name: "settings", tab: next })}
            onClose={() => setDialog(null)}
          />
        )}
      </Show>
      <Show when={dialog()?.name === "mod" && modDialog()}>{(request) => <ModDialogView request={request()} />}</Show>
      <Show when={dialog()?.name === "theme"}>
        <ThemeDialog onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog()?.name === "tasks"}>
        <TodoDialog session={props.session} onClose={() => setDialog(null)} />
      </Show>
      <Show when={dialog()?.name === "export"}>
        <ExportDialog
          fileName={freeExportName(process.cwd(), exportFileName(title()?.title ?? "", new Date()))}
          exists={(name) => statSync(resolve(process.cwd(), name), { throwIfNoEntry: false })?.isFile() ?? false}
          onCopy={() => void exportToClipboard()}
          onSave={(name) => void exportTo(name, true)}
          onClose={() => setDialog(null)}
        />
      </Show>
      <Show when={dialog()?.name === "skills"}>
        <SkillsDialog
          skills={props.provider.skills() ?? []}
          uses={skillUses(props.session, props.provider.skills() ?? [])}
          actions={props.extensions?.skills}
          toggles={props.caps.skills.toggle}
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
      <Show when={dialog()?.name === "context" && props.info}>
        {(info) => <ContextDialog load={() => info().context()} onClose={() => setDialog(null)} />}
      </Show>
      <Show when={dialog()?.name === "usage" && props.info}>
        {(info) => (
          <UsageDialog
            load={() => info().usage()}
            limits={props.caps.limits ? props.session.usage.limits : NO_LIMITS}
            onClose={() => setDialog(null)}
          />
        )}
      </Show>
      <Show when={choiceKind() === "model"}>
        <ChoiceDialog
          title="Model"
          choices={modelIds().map((id) => ({
            id,
            label: modelName(id),
            note: props.provider.models().find((model) => model.ref.id === modelRef(id).id)?.note,
          }))}
          current={settings.model ?? props.model()}
          onChoose={(id) => toModel(pickModel(id))}
          onClose={() => setDialog(null)}
        />
      </Show>
      <Show when={choiceKind() === "effort"}>
        <ChoiceDialog
          title="Effort"
          choices={[...efforts(), { id: "auto", label: "auto", note: "Claude Code picks the level" }]}
          current={settings.effort}
          onChoose={(id) => {
            const level = efforts().find((known) => known.id === id)
            // auto is Claude Code's own, so its /effort sets it.
            if (level) toEffort(pickEffort(level.id))
            else props.onSubmit({ text: "/effort auto", images: [], to: null }, () => {})
          }}
          onClose={() => setDialog(null)}
        />
      </Show>
      <Show when={codeView()}>
        {(view) => (
          <CodeView
            refs={view().refs}
            index={view().index}
            onIndex={(index) => {
              const id = view().ids[index]
              if (id) setSelected(id)
              setDialog({ ...view(), index })
            }}
            onClose={() => setDialog(null)}
            onCopy={copyText}
          />
        )}
      </Show>
      <Show when={dialog()?.name === "resume"}>
        <ResumeDialog sessions={unlisted} onClose={() => setDialog(null)} />
      </Show>
      <Show when={rewindDialog()}>
        {(open) => {
          // Nothing can change the points while the dialog is open, so they are worked out once.
          const points = untrack(() => rewindPoints(props.session, open().extras))
          const late = untrack(open).late?.then((extras) =>
            extras ? { points: rewindPoints(props.session, extras), dryRun: extras.dryRun } : null,
          )
          return (
            <RewindDialog
              points={points}
              dryRun={open().extras?.dryRun}
              late={late}
              onRewind={rewind}
              onFocus={(userId) => scroll?.scrollChildIntoView(userId)}
              onGo={() => {
                timelineFrom = null
                setDialog(null)
              }}
              onCopy={(text) => {
                closeTimeline()
                void copyText(text).then((copied) => waitNotice(copied ? "Prompt copied" : "Could not copy the prompt"))
              }}
              onClose={closeTimeline}
            />
          )
        }}
      </Show>
    </box>
  )
}
