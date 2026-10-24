import { CliRenderEvents, createCliRenderer, destroyTreeSitterClient } from "@opentui/core"
import { render } from "@opentui/solid"
import { existsSync, realpathSync } from "node:fs"
import { constants, homedir } from "node:os"
import { basename, join } from "node:path"
import { parseArgs } from "node:util"
import { type Accessor, createEffect, createRoot, createSignal, on, type Setter, Show } from "solid-js"
import { forgetFiles } from "./input/files.ts"
import { type InputProvider, liveProvider, replayProvider } from "./input/provider.ts"
import { log } from "./log/log.ts"
import { parse } from "./protocol/parse.ts"
import { permissionReply, rewindConversationReply } from "./protocol/messages.ts"
import {
  backgroundTasksRequest,
  interruptRequest,
  shellContext,
  type OutgoingImage,
  ownAskReply,
  renameSession,
  rewindConversationRequest,
  userMessage,
} from "./protocol/outgoing.ts"
import { heldElsewhere } from "./resume/held.ts"
import { CLAUDE_PROJECTS, projectFolder } from "./resume/project-key.ts"
import { listSessions, type SessionEntry } from "./resume/session-list.ts"
import { loadTranscript, promptParent, readTranscript, type TranscriptCursor } from "./resume/transcript.ts"
import { createSession, type SessionStore } from "./session/session.ts"
import { controlProblem, initSettings, setControlProblem, setKnobs, settings } from "./session/settings.ts"
import { loadSettings, savedMode } from "./session/settings-file.ts"
import { stopTitles } from "./session/titler.ts"
import packageJson from "../package.json"
import {
  hiddenPrompts,
  keptReplies,
  loadRewindExtras,
  onlyPaths,
  type RewindPreview,
  type RewindRecheck,
  type Rewound,
  rewoundTasks,
} from "./session/rewind.ts"
import type { Task } from "./session/types.ts"
import { runShell, type ShellRun } from "./source/shell-command.ts"
import { createCapture } from "./rewind/live-rewind.ts"
import { pruneAtStart } from "./rewind/prune.ts"
import { livePreview } from "./rewind/preview.ts"
import { createFileRewind } from "./rewind/rewind-files.ts"
import type { Spawn } from "./source/claude-args.ts"
import { connect, type Connection, pump } from "./source/live.ts"
import { loadRecording, RecordingError, recordedInfo } from "./source/recording.ts"
import { createReplaySource, parseSpeed } from "./source/replay.ts"
import type { Requests } from "./source/requests.ts"
import { readTerminal } from "./theme/palette.ts"
import { setTerminal, startTheme } from "./theme/theme.ts"
import { App } from "./ui/app.tsx"
import { removeViewedImages } from "./ui/dialog/image-view.tsx"
import { forgetRefs } from "./ui/markdown/refs.ts"
import type { McpActions } from "./ui/mcp/mcp-tab.tsx"
import type { PluginActions } from "./ui/settings/plugins-tab.tsx"
import type { SkillActions } from "./ui/skills/skills-dialog.tsx"
import { noteKey } from "./ui/ask/typing.ts"
import { invertQueued } from "./ui/invert.ts"
import { firstCapabilities, TerminalCheck, terminalProblem } from "./ui/terminal-check.tsx"

const USAGE = [
  "Usage: yellowcode [--skip-terminal-check]",
  "       yellowcode --replay <file.jsonl> [--speed <number|instant>] [--titles] [--sessions <folder>] [--skip-terminal-check]",
  "yellowcode is bin/yellowcode in the repo; there, bun run dev takes the same options.",
].join("\n")

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function readArgs() {
  try {
    return parseArgs({
      options: {
        replay: { type: "string" },
        speed: { type: "string" },
        // Session titles cost a Haiku request per user message, so replays only make them when asked.
        titles: { type: "boolean" },
        sessions: { type: "string" },
        "skip-terminal-check": { type: "boolean", default: false },
      },
    }).values
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  }
}

const values = readArgs()
if (values.replay === undefined && (values.speed !== undefined || values.titles !== undefined)) fail(USAGE)
if (values.replay === undefined && values.sessions !== undefined) fail("--sessions only works with --replay")

function gitBranch(): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: process.cwd(),
    stderr: "ignore",
    timeout: 2000,
  })
  if (result.exitCode !== 0) return null
  return result.stdout.toString().trim() || null
}

const cwd = process.cwd()
const home = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path)
const workspace = {
  cwd: home(cwd),
  branch: gitBranch(),
  version: packageJson.version,
}
const sessionsFolder = values.sessions ?? projectFolder(CLAUDE_PROJECTS, cwd)
const sessionsCwd = values.sessions ? null : realpathSync(cwd)
// The replay's session, or the one live starts with; opening another session brings a new store.
const firstSession = createSession({ starting: values.replay === undefined })
// claude starts with flags from the saved settings, so they are read first.
const { settings: stored, problem, backup } = loadSettings()
initSettings(stored)

// The claude YellowCode talks to now; a restart or another session replaces it. Never set in a replay.
let connection: Connection
// What the rest of this file sends requests through, so they reach the claude of the moment.
const liveRequests: Requests = {
  send: (build, timeoutMs) => connection.requests.send(build, timeoutMs),
  settle: (reply) => connection.requests.settle(reply),
  close: (reason) => connection.requests.close(reason),
}
// One for the app's life: each claude fills it from its initialize reply.
const claudeLists = liveProvider(liveRequests)
// The dialogs' actions go to the claude of the moment, so a restart under the same App keeps working.
const mcpActions: McpActions = {
  reconnect: (name) => connection.mcp.actions.reconnect(name),
  setEnabled: (name, enabled) => connection.mcp.actions.setEnabled(name, enabled),
  login: (name) => connection.mcp.actions.login(name),
}
const skillActions: SkillActions = {
  setEnabled: (skill, enabled) => connection.extensions.skills.setEnabled(skill, enabled),
}
const pluginActions: PluginActions = {
  setEnabled: (plugin, enabled) => connection.extensions.plugins.setEnabled(plugin, enabled),
}
// Connections asked to stop whose claude may still run, with the promise of it being gone.
const stopped = new Map<Connection, Promise<void>>()

function stop(old: Connection): Promise<void> {
  let gone = stopped.get(old)
  if (!gone) {
    gone = old.close().finally(() => stopped.delete(old))
    stopped.set(old, gone)
  }
  return gone
}

const idOf = (live: Connection) => live.session.state.info?.id ?? live.spawn.sessionId ?? live.spawn.resume

function liveMode() {
  try {
    // Live shows the model and effort claude reports, and nothing until it does.
    setKnobs({ model: null, effort: null, ultracode: false })
    // A new session gets its id from here, so it is known before claude reports it.
    const spawn = { sessionId: crypto.randomUUID() }
    connection = connect({ cwd, session: firstSession, spawn, stored: settings, provider: claudeLists })
    // After initialize, so claude's first request stays initialize.
    connection.controls.follow({
      initialized: () => {
        if (capture) void pruneAtStart(capture.snapshots, liveRequests)
      },
      onMessage: () => {},
    })
    return { kind: "live" as const, provider: claudeLists }
  } catch (error) {
    return fail(
      `Cannot start claude: ${error instanceof Error ? error.message : String(error)}. Is Claude Code installed?`,
    )
  }
}

async function replayMode(file: string) {
  const speed = parseSpeed(values.speed ?? "1")
  if (speed === null) fail(`Invalid speed "${values.speed}". ${USAGE}`)
  const recording = await loadRecording(file).catch((error: unknown) => {
    fail(error instanceof RecordingError ? `Cannot load replay: ${error.message}` : String(error))
  })
  const source = createReplaySource(recording, speed)
  const info = { file: basename(file), speed: speed === "instant" ? "instant" : `${speed}x`, status: source.status }
  const provider = replayProvider(recording)
  // A replay's Bash changes and conflicts are made up, in a sidecar next to the recording.
  const preview: RewindPreview = () => loadRewindExtras(file)
  return { kind: "replay" as const, source, recording, info, provider, preview }
}

const mode = values.replay === undefined ? liveMode() : await replayMode(values.replay)
// Snapshots of the project around each prompt, for rewinding its files; a replay touches no files.
const capture = mode.kind === "live" ? createCapture(cwd) : null
let unfollow = capture?.follow(firstSession)
const fileRewind = createFileRewind(capture, cwd)
const preview = livePreview(capture, cwd, (session) => fileRewind.pending(session))
const source =
  mode.kind === "live"
    ? { send: (line: string) => connection.source.send(line), close: () => void stop(connection) }
    : mode.source
// A replay answers from its recording, and a request sent to it would release its gate instead.
const requests = mode.kind === "live" ? liveRequests : null
const firstInfo = mode.kind === "replay" ? recordedInfo(mode.recording) : null
const firstModel = firstInfo?.model ?? null
const provider = mode.provider
// A read-only transcript is no live project, so its dialogs show none of claude's lists.
const readOnlyProvider: InputProvider =
  mode.kind === "live"
    ? { ...provider, skills: () => [], settingsSources: () => [], skillRows: () => null, pluginHooks: () => [] }
    : provider
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  consoleMode: "disabled",
  openConsoleOnError: false,
  // A click would otherwise focus the chat's scrollbox and take the keys from the prompt.
  autoFocus: false,
  // OpenTUI sends an image again whenever an image above it scrolls in or out; a file path is cheap to send again.
  kittyImageTransport: "file",
})
const capabilities = firstCapabilities(renderer)
renderer.addPostProcessFn(invertQueued)
renderer.keyInput.on("keypress", noteKey)

// The renderer's own handlers and Node's warning printer write to the terminal, so ours replace them.
process.removeAllListeners("uncaughtException")
process.removeAllListeners("unhandledRejection")
process.removeAllListeners("warning")
const NOTICE = "Something went wrong · details in ~/.yellowcode/logs"
const reported = new Set<string>()

function reportProblem(error: unknown): void {
  try {
    const message = error instanceof Error ? error.message : String(error)
    if (reported.has(message)) return
    reported.add(message)
    const notice = { text: NOTICE }
    setControlProblem(notice)
    setTimeout(() => {
      if (controlProblem() === notice) setControlProblem(null)
    }, 5000).unref()
  } catch {}
}

process.on("uncaughtException", (error) => {
  log.error("uncaught exception", error)
  reportProblem(error)
})
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", reason)
  reportProblem(reason)
})
process.on("warning", (warning) => log.warn("process warning", warning))

async function applyTerminal(): Promise<void> {
  const look = await readTerminal(renderer)
  // A terminal that answers palette queries supports truecolor in practice, so that stands in until capabilities arrive.
  const rgb = renderer.capabilities?.rgb ?? look.tints !== null
  log.info("terminal", { tints: look.tints !== null, dark: look.dark, rgb })
  setTerminal({ ...look, rgb })
}

await applyTerminal()
startTheme(renderer.nativeScene, settings.theme)
// OpenTUI clears its palette cache before it reports a light/dark switch, so the same read picks up the new colors.
renderer.on(CliRenderEvents.THEME_MODE, () => void applyTerminal())

let quitting = false
let shellRun: ShellRun | null = null
// Each close() is bounded on its own; this bounds the quit as a whole.
const QUIT_WAIT_MS = 8000

async function quit(code = 0): Promise<void> {
  if (quitting) return
  quitting = true
  // Files stay as a rewind left them, and claude hears nothing of it.
  fileRewind.stop()
  const sweeping = capture?.stop()
  const shell = shellRun
  shell?.stop()
  source.close()
  stopTitles()
  try {
    await destroyTreeSitterClient()
  } finally {
    // The renderer tears itself down on QUIT_SIGNALS before this runs.
    if (!renderer.isDestroyed) {
      if (renderer.capabilities?.program_status) renderer.setProgramStatus({ state: "clear" })
      renderer.setTerminalTitle("")
      renderer.destroy()
    }
    // The terminal comes back to its normal state asynchronously, and exiting before that leaves it broken.
    await renderer.closed.catch(() => {})
    const ending = mode.kind === "live" ? [...stopped.values(), sweeping] : []
    await Promise.race([Promise.all([...ending, shell?.done]), Bun.sleep(QUIT_WAIT_MS)])
    process.exit(code)
  }
}

// The renderer handles these by tearing itself down without exiting, so they quit the app.
const QUIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT", "SIGPIPE", "SIGBUS"] as const

process.on("exit", () => {
  source.close()
  stopTitles()
  removeViewedImages()
})
for (const signal of QUIT_SIGNALS) process.on(signal, () => void quit(128 + constants.signals[signal]))
process.on("SIGHUP", () => {
  source.close()
  process.exit(129)
})

async function start(): Promise<void> {
  if (mode.kind === "live") {
    connection.start()
    return
  }
  await pump(mode.source, firstSession, null)
  firstSession.end()
}

type View = {
  entry: SessionEntry
  session: SessionStore
  earlier: Accessor<TranscriptCursor | null>
  setEarlier: Setter<TranscriptCursor | null>
}

// A transcript shown read-only (a replay, or --sessions), in place of the main App.
const [view, setView] = createSignal<View | null>(null)
// What the main App shows: the session claude runs (or the replay's), and, once resumed, its transcript.
const [chat, setChat] = createSignal<{ session: SessionStore; resumed: View | null }>({
  session: firstSession,
  resumed: null,
})
// A mode picked after claude last said which one it uses wins at a restart: claude may never have applied it (picked
// while claude was down or restarting, bypassPermissions without the allow flag).
let modePicked = false
createRoot(() => {
  createEffect(
    on(
      () => settings.permissionMode,
      () => (modePicked = true),
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => chat().session.state.permissionMode,
      () => (modePicked = false),
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => chat().session.state.turn,
      (turn, before) => {
        if (turn !== null || before === null || before === undefined) return
        forgetFiles()
        forgetRefs()
      },
    ),
  )
})
let opening = 0

async function open(entry: SessionEntry): Promise<void> {
  const token = ++opening
  const part = await readTranscript(entry.path)
  if (token !== opening) return
  const opened = createSession()
  loadTranscript(opened, part)
  source.close()
  const [earlier, setEarlier] = createSignal(part.earlier)
  setView({ entry, session: opened, earlier, setEarlier })
}

// A turn that runs keeps the session it belongs to; background tasks alone stop, as on quit.
function working(): boolean {
  // A restart that waits for the old claude to end sends the typed message once it has started.
  if (restarting) setControlProblem({ text: "Claude Code is starting again · open the session once it runs" })
  else if (connection.session.state.status === "running")
    setControlProblem({ text: "Claude Code is working · Esc interrupts it, then open the session" })
  else return false
  return true
}

// Continues a session of this project in place, or as a copy when another process runs it (two writers on one file).
async function openLive(entry: SessionEntry): Promise<void> {
  const current = connection
  if (entry.id === idOf(current) || working()) return
  const token = ++opening
  const part = await readTranscript(entry.path)
  if (quitting) return
  // A session left a moment ago may still be writing its file.
  await Promise.all([...stopped].flatMap(([old, gone]) => (idOf(old) === entry.id ? [gone] : [])))
  if (quitting || token !== opening || connection !== current || working()) return
  const copy = heldElsewhere(entry.id)
  const spawn = copy ? { resume: entry.id, fork: true, sessionId: crypto.randomUUID() } : { resume: entry.id }
  const session = createSession({ starting: true })
  session.prepend(part.events)
  const following = capture?.follow(session)
  // Prompts made in Claude Code itself rewind their Edit/Write files from its own backups.
  capture?.adopt(entry.path, entry.id)
  let next: Connection
  try {
    next = connect({ cwd, session, spawn, stored: settings, provider: claudeLists })
  } catch (error) {
    log.error("cannot start claude", error)
    following?.()
    setControlProblem({ text: `Cannot start Claude Code: ${error instanceof Error ? error.message : String(error)}` })
    return
  }
  // Its background agents may write until its claude is gone, and those writes still go to its prompts.
  const left = unfollow
  unfollow = following
  void stop(current).finally(() => left?.())
  fileRewind.release()
  // Opening another session starts from Claude Code's own model and effort.
  setKnobs({ model: null, effort: null, ultracode: false })
  connection = next
  next.start()
  const [earlier, setEarlier] = createSignal(part.earlier)
  setChat({ session, resumed: { entry, session, earlier, setEarlier } })
  if (copy) setControlProblem({ text: "This session is open in another process, so it opened as a copy" })
}

// Set while a restart waits for a claude that stopped responding to end.
let restarting = false

// Claude Code went away on its own: a new claude continues the same conversation, and the message goes to it.
function restart(text: string, images: OutgoingImage[], giveBack: () => void): boolean {
  if (quitting) return false
  const ended = connection
  const { code, signal } = ended.source.exitNow()
  // One that stopped responding can still be running out its grace; a second claude must not write the same file
  // meanwhile, so the start waits for it, and Enter again only refuses to send.
  if (code === null && signal === null) {
    ended.session.restart()
    restarting = true
    void stop(ended).then(() => {
      restarting = false
      if (!relaunch(ended, text, images, undefined, giveBack)) log.warn("the restarted claude took no message")
    })
    return true
  }
  void stop(ended)
  return relaunch(ended, text, images, undefined, giveBack)
}

const transcriptOf = (id: string) => join(projectFolder(CLAUDE_PROJECTS, cwd), `${id}.jsonl`)

// False when no claude took the message, so the prompt keeps it. `chosen` is where the conversation goes on, when
// not where the ended claude left it.
function relaunch(
  ended: Connection,
  text: string,
  images: OutgoingImage[],
  chosen?: Spawn,
  giveBack: () => void = () => {},
): boolean {
  if (quitting || connection !== ended) return false
  const { session } = ended
  const id = session.state.info?.id
  // With nothing on disk the start is repeated, under a new id in case claude took the old one.
  const again = ended.spawn.sessionId ? { ...ended.spawn, sessionId: crypto.randomUUID() } : ended.spawn
  const spawn = chosen ?? (id !== undefined && existsSync(transcriptOf(id)) ? { resume: id } : again)
  const carry = { model: settings.model, effort: settings.effort, ultracode: settings.ultracode }
  // The session goes on in the mode it was in (a plan mode claude entered, edits allowed for the session), not the
  // saved one, unless the user picked one since.
  const goesOn = modePicked ? undefined : (savedMode(session.state.permissionMode) ?? undefined)
  try {
    connection = connect({ cwd, session, spawn, stored: settings, provider: claudeLists, carry, mode: goesOn })
  } catch (error) {
    log.error("cannot start claude", error)
    session.end({ text: "Cannot start Claude Code", detail: [error instanceof Error ? error.message : String(error)] })
    return false
  }
  session.restart()
  connection.start()
  if (!text.trim() && images.length === 0) return true
  // The resumed conversation still holds the prompts a rewind hid.
  if (session.state.rewound)
    void queueRewind(() => sendAfterRewinds(connection, text, images, giveBack)).catch(() => {})
  else sendPrompt(connection, text, images, giveBack)
  return true
}

// Prompts go out in the order they were typed, each once its snapshot is taken or BEFORE_CAP_MS has passed. The
// chat shows each at once.
let sending = Promise.resolve()
// The latest send that starts a turn of its own; an interrupt goes out after it, so it stops that turn.
let turnSend = Promise.resolve()

// `giveBack` returns the text to an empty prompt when the message cannot go out. `told` goes out before the text but
// is not shown.
function sendPrompt(
  live: Connection,
  text: string,
  images: OutgoingImage[],
  giveBack?: () => void,
  told: string[] = [],
  // Goes after the message, so Claude Code does not name things (a plan file) after it.
  after: string[] = [],
): void {
  // A send makes a rewind final, so /redo has nothing to bring back.
  fileRewind.release()
  const uuid = crypto.randomUUID()
  const line = userMessage([...told, text, ...after].filter((part) => part !== "").join("\n\n"), images, uuid)
  const startsTurn = live.session.state.status !== "running"
  live.session.showEarly(told.length + after.length > 0 ? userMessage(text, images, uuid) : line)
  const ready = capture?.before(uuid, idOf(live) ?? null, live.session)
  const unsent = () => {
    capture?.drop(uuid)
    live.session.notSent(uuid)
    giveBack?.()
  }
  sending = sending
    .then(() => ready)
    .then(() => {
      // A claude started since (a restart, another session) is not the one the message was typed for.
      if (connection !== live) {
        log.warn("claude changed before the message went out; dropped it")
        return unsent()
      }
      // A knob change still waiting goes first, so the message runs under it.
      live.controls.flush()
      if (live.source.send(line)) return
      unsent()
      setControlProblem({ text: "Claude Code stopped before the message went out" })
    })
    .catch((error: unknown) => log.error("cannot send the message", error))
  if (startsTurn) turnSend = sending
}

// claude takes no rewind while a turn runs, such as one a kept background task started.
async function idle(live: Connection): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop
  while (live.session.state.status === "running" && accepts(live)) await Bun.sleep(100)
}

// A turn a kept background task starts can come in between: claude refuses while it is queued (commands_queued) or
// runs (turn_running), so the step waits for it and asks again.
const BUSY_REASONS = new Set(["turn_running", "commands_queued"])

async function stepOnce(live: Connection, uuid: string, tries = 10) {
  const reply = await live.requests
    .send((requestId) => rewindConversationRequest(requestId, uuid))
    .catch((error: unknown) => ({ rewound: false, error: error instanceof Error ? error.message : String(error) }))
  const answer = rewindConversationReply.safeParse(reply).data
  if (!BUSY_REASONS.has(answer?.reason ?? "") || tries <= 1) return answer
  await Bun.sleep(200)
  await idle(live)
  return stepOnce(live, uuid, tries - 1)
}

// claude takes only its latest remaining prompt, so it steps back over each, newest first. False at the first one it
// does not take.
async function stepBack(live: Connection, uuids: string[]): Promise<boolean> {
  for (const uuid of uuids) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time, each needs the one before
    const answer = await stepOnce(live, uuid)
    if (!answer?.rewound) {
      log.warn("claude did not rewind the conversation", { error: answer?.error, reason: answer?.reason })
      return false
    }
  }
  return true
}

// The first send after a rewind takes claude's conversation back to the same point: in the running claude, else in
// one started again at what the first hidden prompt hangs from. The claude to send to, or null when the conversation
// cannot go back and nothing was sent.
async function rewindConversation(live: Connection): Promise<Connection | null> {
  const prompts = hiddenPrompts(live.session.state)
  if (prompts.length === 0) return live
  setGoingBack(true)
  try {
    return await goBack(live, prompts)
  } finally {
    setGoingBack(false)
  }
}

const [goingBack, setGoingBack] = createSignal(false)

async function goBack(live: Connection, prompts: (string | undefined)[]): Promise<Connection | null> {
  await idle(live)
  const uuids = prompts.filter((uuid): uuid is string => uuid !== undefined)
  if (uuids.length === prompts.length && (await stepBack(live, uuids))) {
    log.info("conversation rewound", { prompts: uuids.length })
    return live
  }
  const id = idOf(live)
  const first = prompts.at(-1)
  const cut = id && first ? await promptParent(transcriptOf(id), first) : undefined
  if (!id || cut === undefined) {
    noticeRewind("Cannot rewind the conversation to this prompt")
    return null
  }
  log.info("conversation rewound by a restart", { at: cut })
  // The claude that leaves writes its transcript until it ends, so the next one waits.
  restarting = true
  await stop(live)
  restarting = false
  const spawn = cut === null ? { sessionId: crypto.randomUUID() } : { resume: id, at: cut }
  return relaunch(live, "", [], spawn) ? connection : null
}

// A message goes out after the rewinds before it, to the claude that runs its session by then: a restart keeps the
// session.
async function sendAfterRewinds(live: Connection, text: string, images: OutgoingImage[], giveBack: () => void) {
  const current = connection.session === live.session ? connection : live
  const steps = hiddenPrompts(current.session.state).length > 0
  const target = current.session.state.rewound ? await rewindConversation(current) : current
  if (!target) return giveBack()
  // Stepping back took out the turns claude started while rewound because a kept background task finished, so it
  // hears their replies again. A command has to start its message, so they wait for the next one.
  const { session } = target
  const held = untold?.session === session && untold.conversation === session.state.conversation ? untold.replies : []
  const replies = [...held, ...(steps ? keptReplies(session.state) : [])]
  untold = null
  if (text.startsWith("/")) {
    if (replies.length > 0) untold = { session, conversation: session.state.conversation, replies }
    return sendPrompt(target, text, images, giveBack)
  }
  const shells = untoldShells?.session === session ? untoldShells.texts : []
  untoldShells = null
  sendPrompt(
    target,
    text,
    images,
    giveBack,
    replies.map((reply) => `${KEPT_REPLY}\n${reply}`),
    shells,
  )
}

// `!` commands Claude has yet to read; they go out ahead of the next message.
let untoldShells: { session: Connection["session"]; texts: string[] } | null = null

// A replay sends nothing, so its commands are told from the start.
function runShellCommand(session: Connection["session"], command: string): void {
  const told = mode.kind !== "live"
  const id = session.startShell(command, told)
  const run = runShell(command, cwd, (output) => session.shellOutput(id, output))
  shellRun = run
  void run.done.then(({ output, code, stopped: byUser }) => {
    if (shellRun === run) shellRun = null
    session.endShell(id, output, code, byUser)
    if (told) return
    const texts = untoldShells?.session === session ? untoldShells.texts : []
    untoldShells = { session, texts: [...texts, shellContext(command, output)] }
  })
}

let untold: { session: Connection["session"]; conversation: number; replies: string[] } | null = null

const KEPT_REPLY = "While the conversation was rewound, a background task finished and you said:"

// Rewinds and redos run one at a time; a message typed meanwhile goes out after them.
let rewinding: Promise<unknown> = Promise.resolve()

// The warning a rewind or /redo left; the next one replaces it, or clears it when it has nothing to say.
let rewindNotice: string | null = null

function noticeRewind(text: string | null): void {
  if (text) setControlProblem({ text })
  else if (rewindNotice !== null && controlProblem()?.text === rewindNotice) setControlProblem(null)
  rewindNotice = text
}

function keptNotice(kept: string[]): string | null {
  if (kept.length === 0) return null
  return kept.length === 1
    ? `1 file kept as it is: ${kept[0]}`
    : `${kept.length} files kept as they are: ${kept.join(", ")}`
}

// Sentences of one notice; with more than one, each ends with a full stop.
const sentences = (parts: (string | null)[]) => {
  const said = parts.filter((part): part is string => part !== null)
  return said.length === 0 ? null : said.length === 1 ? (said[0] ?? null) : `${said.join(". ")}.`
}

// Rewinds and redos run one at a time, and the dialog does not open meanwhile.
const [rewindWork, setRewindWork] = createSignal(0)

function queueRewind<T>(work: () => Promise<T>): Promise<T> {
  setRewindWork((count) => count + 1)
  const done = rewinding.then(work).finally(() => setRewindWork((count) => count - 1))
  rewinding = done.catch((error: unknown) => log.error("rewind failed", error))
  return done
}

// The turn claude starts by itself when a task from the rewound prompts ends, or when we stop it (stopping an agent
// makes claude start one at once), is interrupted and never shown. The rewound prompts' running tasks.
function hideTaskTurns(live: Connection, rewound: Rewound): Task[] {
  const tasks = rewoundTasks(live.session.state, rewound.userId)
  live.session.hideTurnsOf(
    tasks.map((task) => task.id),
    () =>
      void live.requests.send(interruptRequest).then(
        (reply) => log.info("hidden turn interrupted", reply),
        (error: unknown) => log.warn("hidden turn not interrupted", error instanceof Error ? error.message : error),
      ),
  )
  return tasks
}

// Enter in the rewind dialog: the background tasks the rewound prompts started stop, their files go back, and only
// then does the session rewind. False when the files could not be touched and nothing was rewound; the ⚠ paths and
// files when they changed since the dialog showed them, so it asks again.
async function rewindLive(live: Connection, rewound: Rewound, seen: string[]): Promise<boolean | RewindRecheck> {
  const { session } = live
  const refused = fileRewind.refused(session.state)
  if (refused) {
    noticeRewind(`Cannot rewind the files: ${refused}`)
    return false
  }
  // What comes after it is a turn a kept task started, not one the rewind hides.
  const last = session.state.items.at(-1)
  const tasks = hideTaskTurns(live, rewound)
  const stops = await Promise.all(
    tasks.map((task) =>
      live.tasks.stop(task.id).then(
        () => null,
        (error: unknown) => {
          log.warn("rewind did not stop a task", String(error))
          return task.description || task.command || task.name
        },
      ),
    ),
  )
  const failed = stops.filter((name): name is string => name !== null)
  const stoppedCount = stops.length - failed.length
  const notStopped = failed.length > 0 ? `Could not stop: ${failed.join(", ")}` : null
  const tasksStopped =
    stoppedCount > 0 ? `Stopped ${stoppedCount} background task${stoppedCount === 1 ? "" : "s"}` : null
  const files = await fileRewind.rewind(session.state, rewound.userId, new Set(seen))
  log.info("rewind files", files.kind === "done" ? { changed: files.paths.length, kept: files.kept.length } : files)
  if (files.kind === "failed") {
    noticeRewind(sentences([`Cannot rewind the files: ${files.reason}`, tasksStopped, notStopped]))
    return false
  }
  if (files.kind === "changed") {
    noticeRewind(sentences([tasksStopped, notStopped]))
    return { conflicts: files.conflicts, paths: files.paths }
  }
  session.rewind(
    files.kind === "done"
      ? { ...rewound, last, files: onlyPaths(rewound.files, files.paths) }
      : { ...rewound, last, keptFiles: true },
  )
  noticeRewind(sentences([notStopped, files.kind === "done" ? keptNotice(files.kept) : null]))
  return true
}

// The conversation comes back even when the files cannot.
async function redoLive(live: Connection): Promise<void> {
  const files = await fileRewind.redo(live.session.state)
  log.info("redo files", files.kind === "done" ? { changed: files.paths.length, kept: files.kept.length } : files)
  live.session.redo()
  if (files.kind === "failed") noticeRewind(`Cannot bring the files back: ${files.reason}`)
  else noticeRewind(files.kind === "done" ? keptNotice(files.kept) : null)
}

function accepts(live: Connection): boolean {
  const exit = live.source.exitNow()
  return exit.code === null && exit.signal === null && !exit.closed
}

// A title claude already has (our last rename, or the user's /rename of the same words) is not written again. The
// session is the App's own, so a title for a session left meanwhile goes to its id, which claude refuses.
function rename(live: Requests, session: SessionStore, title: string): void {
  // claude reports the session id with the first init; a title that comes earlier waits for the next message's.
  const id = session.state.info?.id
  if (!id || session.state.claudeTitle === title) return
  void live
    .send((requestId) => renameSession(requestId, title, id))
    .then(
      () => log.info("renamed session", { id }),
      (error: unknown) => log.warn("rename failed", error instanceof Error ? error.message : error),
    )
}

async function loadEarlier(shown: View): Promise<void> {
  const cursor = shown.earlier()
  if (cursor === null) return
  const part = await readTranscript(shown.entry.path, cursor)
  shown.session.prepend(part.events)
  shown.setEarlier(part.earlier)
}

const sessions = {
  // The session claude runs is not one to open. Until claude reports it, that is the one it was started with; after
  // that the App leaves out the id the session reports, which a /clear changes.
  list: async () => {
    const entries = await listSessions(sessionsFolder, sessionsCwd)
    const starting = mode.kind === "live" && connection.session.state.info === null ? idOf(connection) : undefined
    return entries.filter((entry) => entry.id !== starting)
  },
  open: (entry: SessionEntry) => {
    const opened = mode.kind === "live" && values.sessions === undefined ? openLive(entry) : open(entry)
    opened.catch((error: unknown) => log.error("cannot open session", error))
  },
}

const terminal = values["skip-terminal-check"] ? null : terminalProblem(await capabilities)
if (terminal) log.info("terminal problem", terminal)
const [checking, setChecking] = createSignal(terminal !== null)
if (terminal === null) void start()

function Main() {
  return (
    <Show
      when={view()}
      keyed
      fallback={
        // Keyed on what it shows, so a restart keeps the App and another session gets a new one.
        <Show when={chat()} keyed>
          {(current) => (
            <App
              session={current.session.state}
              model={() => current.session.state.info?.model ?? firstModel}
              firstInfo={firstInfo}
              workspace={workspace}
              replay={mode.kind === "replay" ? mode.info : null}
              title={
                current.resumed
                  ? { title: current.resumed.entry.title, summary: current.resumed.entry.firstPrompt }
                  : undefined
              }
              titles={mode.kind === "live" || values.titles === true}
              // The App before it showed the settings file's problem already.
              settingsProblem={current.resumed ? null : problem}
              settingsBackup={current.resumed ? null : backup}
              provider={provider}
              mcpActions={mode.kind === "live" ? mcpActions : undefined}
              skillActions={mode.kind === "live" ? skillActions : undefined}
              pluginActions={mode.kind === "live" ? pluginActions : undefined}
              sessions={sessions}
              earlier={current.resumed ? current.resumed.earlier() !== null : false}
              onEarlier={() => {
                if (!current.resumed) return
                loadEarlier(current.resumed).catch((error: unknown) =>
                  log.error("cannot load earlier conversation", error),
                )
              }}
              onSubmit={(text, images, giveBack) => {
                if (!text.trim() && images.length === 0) {
                  // An empty Enter releases the next recorded message.
                  if (mode.kind === "replay") source.send("")
                  return true
                }
                // A recording has no lifecycle lines to settle a uuid, so a replay sends none.
                if (mode.kind === "replay") return source.send(userMessage(text, images))
                if (!accepts(connection)) return false
                // The prompt clears once this returns; a chat item before that would take the welcome screen's draft
                // with it.
                const live = connection
                void queueRewind(() => sendAfterRewinds(live, text, images, giveBack)).catch(() => {})
                return true
              }}
              onRestart={mode.kind === "live" ? restart : undefined}
              onAnswer={(ask, response) => {
                // The reply carries the tool's whole input (a Write's file) and the user's notes, so only its gist is
                // logged.
                const answer = parse(response)
                const reply =
                  answer.kind === "message" && answer.message.type === "control_response" ? answer.message : null
                const behavior =
                  permissionReply.safeParse(reply?.response.response).data?.behavior ?? reply?.response.subtype
                log.info(`answer to ${ask.toolName}`, { requestId: ask.requestId, behavior })
                if (ask.mcp) {
                  // claude may have given the call up (an interrupt) while the user answered.
                  const now = current.session.state.byId[ask.id]
                  if (now?.kind !== "ask" || now.status !== "pending") return log.info("dropped a late own ask answer")
                  const result = ownAskReply(ask, ask.mcp.rpcId, response)
                  current.session.answer(result)
                  source.send(result)
                  return
                }
                current.session.answer(response)
                // A file outside the project is read before the call may change it.
                const reading =
                  behavior === "allow" && !ask.agent ? capture?.asked(ask.toolUseId, ask.toolName, ask.input) : null
                const asking = connection
                // An answer for a claude that went away meanwhile is dropped.
                if (reading) void reading.finally(() => connection === asking && source.send(response))
                else source.send(response)
              }}
              onQuit={() => void quit()}
              onShell={(command) => runShellCommand(current.session, command)}
              onShellStop={() => shellRun?.stop()}
              onInterrupt={
                requests
                  ? () => {
                      // The interrupt waits for a message that starts the turn, but the chat shows it at once.
                      current.session.interrupting()
                      void turnSend
                        .then(() => requests.send(interruptRequest))
                        .then(
                          (reply) => log.info("interrupted", reply),
                          (error: unknown) => {
                            log.warn("interrupt failed", error instanceof Error ? error.message : error)
                            current.session.interruptFailed()
                          },
                        )
                    }
                  : undefined
              }
              onBackground={
                requests
                  ? () =>
                      void requests.send(backgroundTasksRequest).then(
                        () => log.info("sent foreground tasks to the background"),
                        (error: unknown) => {
                          log.warn("background failed", error instanceof Error ? error.message : error)
                          setControlProblem({ text: "Claude Code did not send it to the background" })
                        },
                      )
                  : undefined
              }
              onTitle={requests ? (title) => rename(requests, current.session, title) : undefined}
              onStopTask={mode.kind === "live" ? (taskId) => connection.tasks.stop(taskId) : undefined}
              rewind={
                mode.kind === "replay"
                  ? {
                      preview: mode.preview,
                      onRewind: (rewound) => {
                        current.session.rewind(rewound)
                        return true
                      },
                      onRedo: () => current.session.redo(),
                    }
                  : {
                      preview: (session, selected) => rewinding.then(() => preview(session, selected)),
                      working: () => rewindWork() > 0,
                      goingBack,
                      onRewind: (rewound, seen) => {
                        log.info("rewind", { prompts: rewound.prompts, keptFiles: rewound.keptFiles })
                        const live = connection
                        if (rewound.keptFiles)
                          return queueRewind(() => {
                            hideTaskTurns(live, rewound)
                            live.session.rewind(rewound)
                            return Promise.resolve(true)
                          })
                        return queueRewind(() => rewindLive(live, rewound, seen)).catch(() => false)
                      },
                      onRedo: () => {
                        const live = connection
                        void queueRewind(() => redoLive(live)).catch(() => {})
                      },
                    }
              }
            />
          )}
        </Show>
      }
    >
      {(shown) => (
        <App
          session={shown.session.state}
          model={() => shown.entry.model ?? firstModel}
          workspace={{ ...workspace, cwd: home(shown.entry.cwd), branch: shown.entry.branch }}
          replay={null}
          readOnly={{ title: shown.entry.title, summary: shown.entry.firstPrompt, modified: shown.entry.modified }}
          titles={false}
          settingsProblem={null}
          provider={readOnlyProvider}
          sessions={sessions}
          earlier={shown.earlier() !== null}
          onEarlier={() => {
            loadEarlier(shown).catch((error: unknown) => log.error("cannot load earlier conversation", error))
          }}
          onSubmit={() => true}
          onAnswer={() => {}}
          onQuit={() => void quit()}
        />
      )}
    </Show>
  )
}

await render(
  () => (
    <Show when={checking() ? terminal : null} fallback={<Main />}>
      {(found) => (
        <TerminalCheck
          problem={found()}
          onContinue={() => {
            setChecking(false)
            void start()
          }}
          onQuit={() => void quit()}
        />
      )}
    </Show>
  ),
  renderer,
)
