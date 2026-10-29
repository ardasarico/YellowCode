import { CliRenderEvents, createCliRenderer, destroyTreeSitterClient } from "@opentui/core"
import { render } from "@opentui/solid"
import { constants } from "node:os"
import { basename } from "node:path"
import { parseArgs } from "node:util"
import { type Accessor, createEffect, createRoot, createSignal, on, type Setter, Show } from "solid-js"
import type { Agent, Prompt, RestartOptions, StartOptions } from "./agent/agent.ts"
import type { Capabilities } from "./agent/capabilities.ts"
import { createRegistry } from "./agent/registry.ts"
import type { HistoryCursor, SessionEntry } from "./agent/sessions.ts"
import { type ClaudeAgent, claudeKind, showPrompt } from "./agents/claude/agent.ts"
import { CLAUDE, CLAUDE_CAPS } from "./agents/claude/caps.ts"
import { CLAUDE_MODES } from "./agents/claude/lists.ts"
import { stopOneShots } from "./agents/claude/one-shot.ts"
import { liveProvider, replayProvider, savedProvider } from "./agents/claude/provider.ts"
import { forgetFiles } from "./input/files.ts"
import { log } from "./log/log.ts"
import { tildePath } from "./rewind/common.ts"
import { createSession, loadHistory, type SessionStore } from "./session/session.ts"
import {
  controlProblem,
  defaultModeOf,
  initSettings,
  setControlProblem,
  setKnobs,
  settings,
} from "./session/settings.ts"
import { claudeCliVersion, hostFacts, logTail, reportMarkdown, settingsFacts, terminalFacts } from "./report.ts"
import { loadSettings } from "./session/settings-file.ts"
import { modOfError, mods, startModUpdates, startMods } from "./mods/mods.ts"
import { apiVersion } from "./mods/version.ts"
import { MOD_USAGE, runModCommand } from "./mods/install/cli.ts"
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
import type { Ask } from "./session/types.ts"
import { runShell, type ShellRun } from "./source/shell-command.ts"
import { createCapture } from "./rewind/live-rewind.ts"
import { pruneAtStart } from "./rewind/prune.ts"
import { livePreview } from "./rewind/preview.ts"
import { createFileRewind } from "./rewind/rewind-files.ts"
import { loadRecording, RecordingError, recordedInfo } from "./source/recording.ts"
import { parseSpeed } from "./source/replay.ts"
import { readTerminal } from "./theme/palette.ts"
import { setTerminal, startTheme } from "./theme/theme.ts"
import { App, type KnobActions, type Message } from "./ui/app.tsx"
import { themeTextSelection } from "./ui/text-selection.ts"
import { removeViewedImages } from "./ui/dialog/image-view.tsx"
import { forgetRefs } from "./ui/markdown/refs.ts"
import { noteKey } from "./ui/ask/typing.ts"
import { invertQueued } from "./ui/invert.ts"
import { firstCapabilities, TerminalCheck, terminalProblem } from "./ui/terminal-check.tsx"

const USAGE = [
  "Usage: yellowcode [--skip-terminal-check] [--no-mods]",
  "       yellowcode --report",
  "       yellowcode --version",
  "       yellowcode --help",
  MOD_USAGE,
  "       yellowcode --replay <file.jsonl> [--speed <number|instant>] [--titles] [--sessions <folder>] [--skip-terminal-check] [--no-mods]",
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
        "no-mods": { type: "boolean", default: false },
        report: { type: "boolean" },
        version: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }).values
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  }
}

if (process.argv[2] === "mod") process.exit(await runModCommand(process.argv.slice(3)))

const values = readArgs()
if (values.replay === undefined && (values.speed !== undefined || values.titles !== undefined)) fail(USAGE)
if (values.replay === undefined && values.sessions !== undefined) fail("--sessions only works with --replay")
if (values.report && values.replay !== undefined) fail(USAGE)
if (values.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}
if (values.version) {
  const claude = claudeCliVersion()
  process.stdout.write(
    `yellowcode ${packageJson.version} (mod API ${apiVersion})\n${claude ? `Claude Code ${claude}` : "Claude Code not found"}\n`,
  )
  process.exit(0)
}
if (values.report) {
  const loaded = loadSettings()
  process.stdout.write(
    reportMarkdown({
      environment: [...hostFacts(claudeCliVersion()), ...terminalFacts(null)],
      settings: settingsFacts(loaded.settings, CLAUDE, CLAUDE_MODES, loaded.problem),
      log: logTail(50),
    }),
  )
  process.exit(0)
}

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
const workspace = {
  cwd: tildePath(cwd),
  branch: gitBranch(),
  version: packageJson.version,
}
// The replay's session, or the one live starts with; opening another session brings a new store.
const firstSession = createSession({ starting: values.replay === undefined })
// claude starts with flags from the saved settings, so they are read first.
const { settings: stored, problem, backup } = loadSettings()
initSettings(stored)
await startMods(values["no-mods"], { id: CLAUDE, caps: CLAUDE_CAPS })

// The agent of the session YellowCode runs now; another session replaces it. Never set in a replay.
let agent: ClaudeAgent
// One for the app's life: each claude fills it from its initialize reply.
const claudeLists = liveProvider((query) => agent.files(query))

// No task of a saved conversation runs, so none can be sent to the background.
const recorded = (caps: Capabilities): Capabilities => ({ ...caps, backgroundNow: false })

// The App's intents go to the agent of the moment, so a restart under the same App keeps working.
const taskActions: Agent["tasks"] = {
  stop: (id) => agent.tasks.stop(id),
  background: () => agent.tasks.background(),
}
const extensions: Pick<Agent, "mcp" | "skills" | "plugins"> = {
  mcp: {
    toggle: (name, enabled) => agent.mcp.toggle(name, enabled),
    reconnect: (name) => agent.mcp.reconnect(name),
    login: (name) => agent.mcp.login(name),
  },
  skills: {
    toggle: (id, enabled) => agent.skills.toggle(id, enabled),
    reload: () => agent.skills.reload(),
  },
  plugins: {
    toggle: (id, enabled) => agent.plugins.toggle(id, enabled),
    reload: () => agent.plugins.reload(),
  },
}
const knobs: KnobActions = {
  setMode: (mode) => agent.setMode(mode),
  setModel: (model) => agent.setModel(model),
  setEffort: (effort) => agent.setEffort(effort),
  setExtraEffort: (ultracode) => agent.setExtraEffort(ultracode),
  setThinking: (shown) => agent.setThinking(shown),
}
const infoReads: Pick<Agent, "context" | "usage" | "settings"> = {
  context: () => agent.context(),
  usage: () => agent.usage(),
  settings: {
    rows: () => agent.settings.rows(),
    write: (id, value) => agent.settings.write(id, value),
  },
}
const claude = claudeKind(
  {
    provider: claudeLists,
    // A file outside the project is read before an allowed call may change it.
    beforeAllow: (ask: Ask) => capture?.asked(ask.toolUseId, ask.writes),
  },
  values.sessions ?? null,
)
// The agents whose sessions /resume and Recent list.
const installed = createRegistry([claude])

// Claude starts with the saved thinking display and mode, and its own model and effort.
const startOptions = (resume: StartOptions["resume"]): StartOptions => ({
  cwd,
  resume,
  mode: null,
  defaultMode: defaultModeOf(claude.id),
  model: null,
  effort: null,
  extraEffort: false,
  thinking: settings.thinking !== "hidden",
  instructions: [],
  clientTools: [],
  mcpServers: [],
})

// A restarted session goes on in the mode it was in, unless the user picked a saved mode since (see modePicked).
const restartOptions = (): RestartOptions => ({
  mode: modePicked ? defaultModeOf(claude.id) : null,
  defaultMode: defaultModeOf(claude.id),
  thinking: settings.thinking !== "hidden",
})

// Agents asked to close whose claude may still run, with the promise of it being gone.
const stopped = new Map<ClaudeAgent, Promise<void>>()

function stop(old: ClaudeAgent): Promise<void> {
  let gone = stopped.get(old)
  if (!gone) {
    gone = old.close().finally(() => stopped.delete(old))
    stopped.set(old, gone)
  }
  return gone
}

// Ends what feeds the chat: the live agent, or the replay.
function closeSource(): void {
  if (mode.kind === "live") void stop(agent)
  else void mode.replay.close()
}

async function liveMode() {
  try {
    // Live shows the model and effort claude reports, and nothing until it does.
    setKnobs({ model: null, effort: null, ultracode: false })
    agent = await claude.start(startOptions(null), firstSession)
    return { kind: "live" as const, provider: claudeLists, first: agent }
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
  // A replay is a Claude recording.
  const replay = claude.replay(recording, speed, firstSession)
  const info = {
    file: basename(file),
    speed: speed === "instant" ? "instant" : `${speed}x`,
    status: replay.replayStatus,
  }
  const provider = replayProvider(recording)
  // A replay's Bash changes and conflicts are made up, in a sidecar next to the recording.
  const preview: RewindPreview = () => loadRewindExtras(file)
  return { kind: "replay" as const, replay, recording, info, provider, preview }
}

const mode = values.replay === undefined ? await liveMode() : await replayMode(values.replay)
// Snapshots of the project around each prompt, for rewinding its files; a replay touches no files.
const capture = mode.kind === "live" ? createCapture(cwd) : null
// Asks the first claude, even when another session runs by the time the snapshots are ready.
if (mode.kind === "live" && capture) {
  const { first } = mode
  void pruneAtStart(capture.snapshots, () => first.sessionDays())
}
let unfollow = capture?.follow(firstSession)
const fileRewind = createFileRewind(capture, cwd)
const preview = livePreview(capture, cwd, (session) => fileRewind.pending(session))
const firstInfo = mode.kind === "replay" ? recordedInfo(mode.recording) : null
const firstModel = firstInfo?.model ?? null
const provider = mode.provider
const readOnlyProvider = mode.kind === "live" ? savedProvider(provider) : provider
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
const NOTICE = "Something went wrong · /report copies details for a bug report"
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
// OpenTUI catches a mouse handler's throw; one from a mod's own box turns that mod off.
renderer.on(CliRenderEvents.HANDLER_ERROR, ({ error }: { error: unknown }) => {
  const mod = modOfError(error)
  if (mod) mods.fail(mod, error)
  else log.error("a mouse handler failed", error)
})

let quitting = false
let shellRun: ShellRun | null = null
// Each close() is bounded on its own; this bounds the quit as a whole.
const QUIT_WAIT_MS = 8000

async function quit(code = 0): Promise<void> {
  if (quitting) return
  quitting = true
  mods.unloadAll()
  // Files stay as a rewind left them, and claude hears nothing of it.
  fileRewind.stop()
  const sweeping = capture?.stop()
  const shell = shellRun
  shell?.stop()
  closeSource()
  stopOneShots()
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
  closeSource()
  stopOneShots()
  removeViewedImages()
})
for (const signal of QUIT_SIGNALS) process.on(signal, () => void quit(128 + constants.signals[signal]))
process.on("SIGHUP", () => {
  closeSource()
  process.exit(129)
})

function start(): void {
  if (mode.kind === "live") agent.begin()
  else mode.replay.begin()
}

type View = {
  entry: SessionEntry
  session: SessionStore
  earlier: Accessor<HistoryCursor | null>
  setEarlier: Setter<HistoryCursor | null>
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
      () => defaultModeOf(claude.id),
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
  const part = await installed.kindOf(entry.ref).history(entry.ref, null)
  if (token !== opening) return
  const opened = createSession()
  loadHistory(opened, part.events)
  closeSource()
  const [earlier, setEarlier] = createSignal(part.earlier)
  setView({ entry, session: opened, earlier, setEarlier })
}

// A turn that runs keeps the session it belongs to; background tasks alone stop, as on quit.
function working(): boolean {
  // A restart that waits for the old claude to end sends the typed message once it has started.
  if (agent.restarting) setControlProblem({ text: "Claude Code is starting again · open the session once it runs" })
  else if (agent.store.state.status === "running")
    setControlProblem({ text: "Claude Code is working · Esc interrupts it, then open the session" })
  else return false
  return true
}

// Continues a session of this project in place, or as a copy when another process runs it (two writers on one file).
async function openLive(entry: SessionEntry): Promise<void> {
  const current = agent
  const { run } = current
  const { ref } = entry
  if (ref.id === current.session.id || working()) return
  const token = ++opening
  const part = await claude.history(ref, null)
  if (quitting) return
  // A session left a moment ago may still be writing its file.
  await Promise.all([...stopped].flatMap(([old, gone]) => (old.session.id === ref.id ? [gone] : [])))
  if (quitting || token !== opening || agent.run !== run || working()) return
  const copy = await claude.heldElsewhere(ref)
  if (quitting || token !== opening || agent.run !== run || working()) return
  const session = createSession({ starting: true })
  session.prepend(part.events)
  const following = capture?.follow(session)
  // Prompts made in the agent itself rewind the files they changed from its own backups.
  if (claude.caps.features.includes("fileHistory")) capture?.adopt(ref.id, (wanted) => claude.fileHistory(ref, wanted))
  let next: ClaudeAgent
  try {
    next = await claude.start(startOptions({ ref, fork: copy, at: null }), session)
  } catch (error) {
    log.error("cannot start claude", error)
    following?.()
    setControlProblem({ text: `Cannot start Claude Code: ${error instanceof Error ? error.message : String(error)}` })
    return
  }
  if (quitting || token !== opening || agent.run !== run) {
    void next.close()
    following?.()
    return
  }
  // Its background agents may write until its claude is gone, and those writes still go to its prompts.
  const left = unfollow
  unfollow = following
  void stop(current).finally(() => left?.())
  fileRewind.release()
  // Opening another session starts from Claude Code's own model and effort.
  setKnobs({ model: null, effort: null, ultracode: false })
  agent = next
  next.begin()
  const [earlier, setEarlier] = createSignal(part.earlier)
  setChat({ session, resumed: { entry, session, earlier, setEarlier } })
  if (copy) setControlProblem({ text: "This session is open in another process, so it opened as a copy" })
}

// Claude Code went away on its own: a new claude continues the same conversation, and the message goes to it. One
// that stopped responding can still be running out its grace, so the agent waits for it, and Enter again only refuses
// to send.
function restart(message: Message, giveBack: () => void): boolean {
  if (quitting) return false
  const target = agent
  const restarted = target.restartNow(restartOptions())
  // Nothing had to wait: a claude that cannot be started leaves the message in the prompt.
  if (!(restarted instanceof Promise)) {
    if (!restarted.ok) return false
    relaunch(target, message, giveBack)
    return true
  }
  void restarted.then((done) => {
    if (done.ok) return relaunch(target, message, giveBack)
    log.warn("the restarted claude took no message")
    giveBack()
  })
  return true
}

function relaunch(target: ClaudeAgent, message: Message, giveBack: () => void): void {
  if (message.to === null && !message.text.trim() && message.images.length === 0) return
  // The resumed conversation still holds the prompts a rewind hid.
  if (target.store.state.rewound) sendRewound(target, message, giveBack)
  else sendPrompt(target, message, giveBack)
}

// Prompts go out in the order they were typed, each once its snapshot is taken or BEFORE_CAP_MS has passed. The
// chat shows each at once.
let sending = Promise.resolve()
// The latest send that starts a turn of its own; an interrupt goes out after it, so it stops that turn.
let turnSend = Promise.resolve()

// `giveBack` returns the text to an empty prompt when the message cannot go out. `kept` goes out before the text but
// is not shown.
function sendPrompt(
  target: ClaudeAgent,
  message: Message,
  giveBack?: () => void,
  kept: string[] = [],
  // Goes after the message, so Claude Code does not name things (a plan file) after it.
  shells: Prompt["shells"] = [],
): void {
  // A send makes a rewind final, so /redo has nothing to bring back.
  fileRewind.release()
  const uuid = crypto.randomUUID()
  const prompt: Prompt = { ...message, id: uuid, command: null, delivery: "steer", kept, shells }
  const { store: session, run } = target
  const startsTurn = session.state.status !== "running"
  showPrompt(session, prompt)
  const ready = capture?.before(uuid, target.session.id || null, session)
  const unsent = () => {
    capture?.drop(uuid)
    session.notSent(uuid)
    giveBack?.()
  }
  sending = sending
    .then(() => ready)
    .then(() => {
      // A claude started since (a restart, another session) is not the one the message was typed for.
      if (agent.run !== run) {
        log.warn("claude changed before the message went out; dropped it")
        return unsent()
      }
      return target.send(prompt).then((sent) => {
        if (sent.ok) return
        unsent()
        setControlProblem({ text: sent.problem })
      })
    })
    .catch((error: unknown) => log.error("cannot send the message", error))
  if (startsTurn) turnSend = sending
}

const [goingBack, setGoingBack] = createSignal(false)

// False when the live claude cannot take the message.
function sendLive(message: Message, giveBack: () => void): boolean {
  if (!agent.accepts()) return false
  // The prompt clears once this returns; a chat item before that would take the welcome screen's draft with it.
  sendRewound(agent, message, giveBack)
  return true
}

// The prompt is already cleared when this runs, so a failure gives the text back.
function sendRewound(target: ClaudeAgent, message: Message, giveBack: () => void): void {
  void queueRewind(() => sendAfterRewinds(target, message, giveBack)).catch((error: unknown) => {
    log.error("cannot send after the rewind", error)
    giveBack()
    setControlProblem({ text: "The message did not go out" })
  })
}

// A message goes out after the rewinds before it: the conversation goes back to the rewound prompt first, and the
// chat shows the message only then. A restart keeps the session.
async function sendAfterRewinds(target: ClaudeAgent, message: Message, giveBack: () => void) {
  const session = target.store
  const steps = hiddenPrompts(session.state).length > 0
  if (steps) setGoingBack(true)
  const back = await target.goBack(restartOptions()).finally(() => setGoingBack(false))
  if (!back.ok) {
    if (back.problem !== null) noticeRewind(back.problem)
    return giveBack()
  }
  // Going back took out the turns the agent started while rewound because a kept background task finished, so it
  // hears their replies again.
  const kept = steps ? keptReplies(session.state) : []
  // A command has to start its message, so the `!` commands stay here for the next one.
  if (message.to === null && message.text.startsWith("/")) return sendPrompt(target, message, giveBack, kept)
  const shells = untoldShells?.session === session ? untoldShells.shells : []
  untoldShells = null
  sendPrompt(target, message, giveBack, kept, shells)
}

// `!` commands Claude has yet to read; they go out ahead of the next message.
let untoldShells: { session: SessionStore; shells: Prompt["shells"] } | null = null

// A replay sends nothing, so its commands are told from the start.
function runShellCommand(session: SessionStore, command: string): void {
  const told = mode.kind !== "live"
  const id = session.startShell(command, told)
  const run = runShell(command, cwd, (output) => session.shellOutput(id, output))
  shellRun = run
  void run.done.then(({ output, code, stopped: byUser }) => {
    if (shellRun === run) shellRun = null
    session.endShell(id, output, code, byUser)
    if (told) return
    const shells = untoldShells?.session === session ? untoldShells.shells : []
    untoldShells = { session, shells: [...shells, { command, output }] }
  })
}

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

// The conversation goes back with the next send; until then the agent hides the turns the rewound prompts' tasks
// start.
function cutConversation(target: ClaudeAgent, rewound: Rewound): void {
  const item = target.store.state.byId[rewound.userId]
  if (item?.kind !== "user" || item.uuid === undefined) return log.warn("rewound prompt has no id; its task turns show")
  void target.cut(item.uuid).then((done) => {
    if (!done.ok) log.warn("cut refused", done.problem)
  })
}

// Enter in the rewind dialog: the background tasks the rewound prompts started stop, their files go back, and only
// then does the session rewind. False when the files could not be touched and nothing was rewound; the ⚠ paths and
// files when they changed since the dialog showed them, so it asks again.
async function rewindLive(target: ClaudeAgent, rewound: Rewound, seen: string[]): Promise<boolean | RewindRecheck> {
  const session = target.store
  const refused = fileRewind.refused(session.state)
  if (refused) {
    noticeRewind(`Cannot rewind the files: ${refused}`)
    return false
  }
  // What comes after it is a turn a kept task started, not one the rewind hides.
  const last = session.state.items.at(-1)
  const tasks = rewoundTasks(session.state, rewound.userId)
  cutConversation(target, rewound)
  const stops = await Promise.all(
    tasks.map((task) =>
      target.tasks.stop(task.id).then((done) => {
        if (done.ok) return null
        log.warn("rewind did not stop a task", done.problem)
        return task.description || task.command || task.name
      }),
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
  const untracked =
    files.kind === "untracked" && files.which
      ? `Files were not rewound: ${files.which === "later" ? "a later" : "this"} prompt was not tracked`
      : null
  noticeRewind(sentences([untracked, notStopped, files.kind === "done" ? keptNotice(files.kept) : null]))
  return true
}

// The conversation comes back even when the files cannot.
async function redoLive(target: ClaudeAgent): Promise<void> {
  const files = await fileRewind.redo(target.store.state)
  log.info("redo files", files.kind === "done" ? { changed: files.paths.length, kept: files.kept.length } : files)
  target.store.redo()
  void target.undoCut()
  if (files.kind === "failed") noticeRewind(`Cannot bring the files back: ${files.reason}`)
  else noticeRewind(files.kind === "done" ? keptNotice(files.kept) : null)
}

// The session is the App's own; a title for a session left meanwhile is dropped.
function rename(session: SessionStore, title: string): void {
  if (session === agent.store) void agent.rename(title)
}

async function loadEarlier(shown: View): Promise<void> {
  const cursor = shown.earlier()
  if (cursor === null) return
  const part = await installed.kindOf(shown.entry.ref).history(shown.entry.ref, cursor)
  shown.session.prepend(part.events)
  shown.setEarlier(part.earlier)
}

const sessions = {
  // The session claude runs is not one to open. Until claude reports it, that is the one it was started with; after
  // that the App leaves out the id the session reports, which a /clear changes.
  list: async () => {
    const entries = await installed.sessions(cwd)
    const starting = mode.kind === "live" && agent.store.state.info === null ? agent.session : undefined
    return entries.filter((entry) => entry.ref.agent !== starting?.agent || entry.ref.id !== starting.id)
  },
  open: (entry: SessionEntry) => {
    const opened = mode.kind === "live" && values.sessions === undefined ? openLive(entry) : open(entry)
    opened.catch((error: unknown) => log.error("cannot open session", error))
  },
}

const terminal = values["skip-terminal-check"] ? null : terminalProblem(await capabilities)
if (terminal) log.info("terminal problem", terminal)
const [checking, setChecking] = createSignal(terminal !== null)
if (terminal === null) start()

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
              agent={mode.kind === "live" ? installed.kindOf(agent.session) : claude}
              caps={mode.kind === "live" ? agent.caps : mode.replay.caps}
              model={() => current.session.state.info?.model ?? firstModel}
              firstInfo={firstInfo}
              workspace={workspace}
              replay={mode.kind === "replay" ? mode.info : null}
              title={
                current.resumed
                  ? { title: current.resumed.entry.title, summary: current.resumed.entry.firstPrompt }
                  : undefined
              }
              oneShot={mode.kind === "live" || values.titles === true ? claude.oneShot : undefined}
              // The App before it showed the settings file's problem already.
              settingsProblem={current.resumed ? null : problem}
              settingsBackup={current.resumed ? null : backup}
              provider={provider}
              extensions={mode.kind === "live" ? extensions : undefined}
              sessions={sessions}
              earlier={current.resumed ? current.resumed.earlier() !== null : false}
              onEarlier={() => {
                if (!current.resumed) return
                loadEarlier(current.resumed).catch((error: unknown) =>
                  log.error("cannot load earlier conversation", error),
                )
              }}
              onSubmit={(message, giveBack) => {
                const empty = message.to === null && !message.text.trim() && message.images.length === 0
                if (mode.kind === "replay") {
                  // An empty Enter releases the next recorded message.
                  if (!empty && !mode.replay.accepts()) return false
                  const prompt = { ...message, id: "", command: null, delivery: "steer" as const, kept: [], shells: [] }
                  void mode.replay.send(prompt)
                  return true
                }
                return empty || sendLive(message, giveBack)
              }}
              onRestart={mode.kind === "live" ? restart : undefined}
              onAnswer={(ask, reply) => {
                void (mode.kind === "replay" ? mode.replay : agent).answer(ask.requestId, reply)
              }}
              onQuit={() => void quit()}
              onShell={(command) => runShellCommand(current.session, command)}
              onShellStop={() => shellRun?.stop()}
              onInterrupt={
                mode.kind === "live"
                  ? () => {
                      // The interrupt waits for a message that starts the turn, but the chat shows it at once.
                      current.session.interrupting()
                      const asked = agent
                      void turnSend.then(() => asked.interrupt())
                    }
                  : undefined
              }
              tasks={mode.kind === "live" ? taskActions : undefined}
              onTitle={mode.kind === "live" ? (title) => rename(current.session, title) : undefined}
              knobs={mode.kind === "live" ? knobs : undefined}
              info={mode.kind === "live" ? infoReads : undefined}
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
                      offReason: () => capture?.offReason(),
                      working: () => rewindWork() > 0,
                      goingBack,
                      onRewind: (rewound, seen) => {
                        log.info("rewind", { prompts: rewound.prompts, keptFiles: rewound.keptFiles })
                        const target = agent
                        if (rewound.keptFiles)
                          return queueRewind(() => {
                            cutConversation(target, rewound)
                            target.store.rewind(rewound)
                            return Promise.resolve(true)
                          })
                        return queueRewind(() => rewindLive(target, rewound, seen)).catch(() => false)
                      },
                      onRedo: () => {
                        const target = agent
                        void queueRewind(() => redoLive(target)).catch((error: unknown) => {
                          log.error("redo failed", error)
                          noticeRewind("Cannot bring the conversation back")
                        })
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
          agent={installed.kindOf(shown.entry.ref)}
          caps={recorded(installed.kindOf(shown.entry.ref).caps)}
          model={() => shown.entry.model?.id ?? firstModel}
          workspace={{ ...workspace, cwd: tildePath(shown.entry.cwd), branch: shown.entry.branch }}
          replay={null}
          readOnly={{ title: shown.entry.title, summary: shown.entry.firstPrompt, modified: shown.entry.modified }}
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

themeTextSelection()
await render(
  () => (
    <Show when={checking() ? terminal : null} fallback={<Main />}>
      {(found) => (
        <TerminalCheck
          problem={found()}
          onContinue={() => {
            setChecking(false)
            start()
          }}
          onQuit={() => void quit()}
        />
      )}
    </Show>
  ),
  renderer,
)
// After the first frame, or a second when the renderer stays busy, so the network never holds up the start.
void Promise.race([renderer.idle(), Bun.sleep(1000)]).then(() => startModUpdates(values["no-mods"]))
