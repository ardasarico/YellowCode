import { appVersion } from "./build-info.ts"
import { CliRenderEvents, createCliRenderer, destroyTreeSitterClient } from "@opentui/core"
import { render } from "@opentui/solid"
import { constants } from "node:os"
import { basename } from "node:path"
import { parseArgs } from "node:util"
import { type Accessor, createEffect, createRoot, createSignal, on, type Setter, Show } from "solid-js"
import type { Agent, AgentKind, ClientTool, Detection, Prompt, RestartOptions, StartOptions } from "./agent/agent.ts"
import type { AskReply } from "./agent/ask.ts"
import type { Capabilities } from "./agent/capabilities.ts"
import type { AgentKindId } from "./agent/ids.ts"
import { createRegistry, type SessionKind } from "./agent/registry.ts"
import type { HistoryCursor, SessionEntry, SessionRef } from "./agent/sessions.ts"
import { type ClaudeHooks, claudeKind, showPrompt } from "./agents/claude/agent.ts"
import { CLAUDE, CLAUDE_NAME } from "./agents/claude/caps.ts"
import { detect as detectClaude } from "./agents/claude/detect.ts"
import { CLAUDE_MODES } from "./agents/claude/lists.ts"
import { mcpRows } from "./agents/claude/mcp-rows.ts"
import { stopOneShots } from "./agents/claude/one-shot.ts"
import { liveProvider, replayProvider, savedProvider } from "./agents/claude/provider.ts"
import { codexKind } from "./agents/codex/agent.ts"
import { CODEX, CODEX_NAME } from "./agents/codex/caps.ts"
import { detect as detectCodex } from "./agents/codex/detect.ts"
import { opencodeKind } from "./agents/opencode/agent.ts"
import { OPENCODE, OPENCODE_NAME } from "./agents/opencode/caps.ts"
import { detect as detectOpencode } from "./agents/opencode/detect.ts"
import { listedProvider, opencodeProvider } from "./agents/opencode/provider.ts"
import { commandOf } from "./input/commands.ts"
import { forgetFiles } from "./input/files.ts"
import type { InputProvider } from "./input/provider.ts"
import { log } from "./log/log.ts"
import { tildePath } from "./rewind/common.ts"
import { follow, showEarly } from "./session/follow.ts"
import { createSession, loadHistory, type SessionStore } from "./session/session.ts"
import {
  controlProblem,
  defaultModeOf,
  initSettings,
  setControlProblem,
  setKnobs,
  setSessionSettings,
  settings,
} from "./session/settings.ts"
import { agentVersions, hostFacts, logTail, reportMarkdown, settingsFacts, terminalFacts } from "./report.ts"
import { loadSettings, pickAgent } from "./session/settings-file.ts"
import { modOfError, mods, modsFor, startModUpdates, startMods } from "./mods/mods.ts"
import { apiVersion } from "./mods/version.ts"
import { MOD_USAGE, runModCommand } from "./mods/install/cli.ts"
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
import type { AgentChoice } from "./ui/agent-dialog.tsx"
import { App, type KnobActions, type Message } from "./ui/app.tsx"
import { everywhereAsk, everywhereOf, heldOf, peerAsk } from "./peers/ask.ts"
import { sessionMessage } from "./peers/envelope.ts"
import { startPeers } from "./peers/host.ts"
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
const KNOWN_AGENTS = [
  { id: CLAUDE, name: CLAUDE_NAME, detect: () => detectClaude() },
  { id: OPENCODE, name: OPENCODE_NAME, detect: () => detectOpencode() },
  { id: CODEX, name: CODEX_NAME, detect: () => detectCodex() },
]
if (values.version) {
  const agents = (await agentVersions(KNOWN_AGENTS)).map(({ name, version }) => `${name} ${version ?? "not found"}`)
  process.stdout.write(`yellowcode ${appVersion} (mod API ${apiVersion})\n${agents.join("\n")}\n`)
  process.exit(0)
}
if (values.report) {
  const loaded = loadSettings(undefined, false)
  const ids = [CLAUDE, OPENCODE, CODEX]
  const running = await pickAgent(loaded.settings.defaultAgent, ids, async (id) => {
    const detection = await KNOWN_AGENTS.find((agent) => agent.id === id)?.detect()
    return detection?.installed === true && detection.blocked === null
  })
  process.stdout.write(
    reportMarkdown({
      environment: [...hostFacts(await agentVersions(KNOWN_AGENTS)), ...terminalFacts(null)],
      settings: settingsFacts(
        loaded.settings,
        {
          id: running ?? CLAUDE,
          name: KNOWN_AGENTS.find((agent) => agent.id === running)?.name ?? CLAUDE_NAME,
          modes: running === undefined || running === CLAUDE ? CLAUDE_MODES : [],
        },
        [
          { id: CLAUDE, name: CLAUDE_NAME },
          { id: OPENCODE, name: OPENCODE_NAME },
          { id: CODEX, name: CODEX_NAME },
        ],
        loaded.problem,
      ),
      log: logTail(50),
    }),
  )
  process.exit(0)
}

if (!process.stdin.isTTY || !process.stdout.isTTY) fail("yellowcode needs a terminal; stdin and stdout must be a TTY")

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
  version: appVersion,
}
// The replay's session, or the one live starts with; opening another session brings a new store.
const firstSession = createSession({ starting: values.replay === undefined })
// The agent starts with the saved settings, so they are read first.
const { settings: stored, problem, backup } = loadSettings()
initSettings(stored)

type Back = { ok: true } | { ok: false; problem: string | null }

// How the app runs one kind of agent.
type Runner = {
  kind: SessionKind & Pick<AgentKind, "detect" | "heldElsewhere" | "oneShot" | "fileHistory">
  provider: InputProvider
  // The store follows the agent's events. Claude's agent still feeds the store itself, and brings the hooks the app
  // still needs of it; an agent of another kind brings none. `goBack` takes the cut before a message after a rewind
  // goes out, so the chat shows it only once the conversation went back; an agent without one takes the cut with the
  // send. Not ok: the message does not go out; `problem` null when there is nothing to tell.
  start(
    options: StartOptions,
    store: SessionStore,
  ): Promise<{ agent: Agent; hooks: Partial<ClaudeHooks>; goBack?: () => Promise<Back> }>
  // The prompt in the chat at Enter, before it goes out; the store's own showEarly for an agent without one.
  show?: (store: SessionStore, prompt: Prompt) => void
  // The output of `!` commands goes to the agent with the next message (Prompt.shells).
  hearsShells: boolean
  // The agent starts over on a typed /clear itself; otherwise YellowCode starts a new session of it.
  clears: boolean
}

// A running agent and the store its events go to.
type Live = {
  runner: Runner
  agent: Agent
  store: SessionStore
  hooks: Partial<ClaudeHooks>
  goBack?: () => Promise<Back>
}

// The agent of the session YellowCode runs now; another session replaces it. Never set in a replay.
let live: Live
// One for the app's life: each claude fills it from its initialize reply.
const claudeLists = liveProvider((query) => live.agent.files(query))

// No task of a saved conversation runs, so none can be sent to the background.
const recorded = (caps: Capabilities): Capabilities => ({ ...caps, backgroundNow: false })

// The App's intents go to the agent of the moment, so a restart under the same App keeps working.
const taskActions: Agent["tasks"] = {
  stop: (id) => live.agent.tasks.stop(id),
  background: () => live.agent.tasks.background(),
}
const extensions: Pick<Agent, "mcp" | "skills" | "plugins"> = {
  mcp: {
    toggle: (name, enabled) => live.agent.mcp.toggle(name, enabled),
    reconnect: (name) => live.agent.mcp.reconnect(name),
    login: (name) => live.agent.mcp.login(name),
  },
  skills: {
    toggle: (id, enabled) => live.agent.skills.toggle(id, enabled),
    reload: () => live.agent.skills.reload(),
  },
  plugins: {
    toggle: (id, enabled) => live.agent.plugins.toggle(id, enabled),
    reload: () => live.agent.plugins.reload(),
  },
}
const knobs: KnobActions = {
  setMode: (mode) => live.agent.setMode(mode),
  setModel: (model) => live.agent.setModel(model),
  setEffort: (effort) => live.agent.setEffort(effort),
  setExtraEffort: (ultracode) => live.agent.setExtraEffort(ultracode),
  setThinking: (shown) => live.agent.setThinking(shown),
}
const infoReads: Pick<Agent, "context" | "usage" | "settings"> = {
  context: () => live.agent.context(),
  usage: () => live.agent.usage(),
  settings: {
    rows: () => live.agent.settings.rows(),
    write: (id, value) => live.agent.settings.write(id, value),
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
const claudeRunner: Runner = {
  kind: claude,
  provider: claudeLists,
  start: (options, store) =>
    claude
      .start(options, store)
      .then((agent) => ({ agent, hooks: agent, goBack: () => agent.goBack(restartOptions()) })),
  show: showPrompt,
  hearsShells: true,
  clears: true,
}
const opencode = opencodeKind()
const opencodeRunner: Runner = {
  kind: opencode,
  // The lists of the session on screen, which is opencode's while this runner's provider is in use.
  provider: opencodeProvider(
    () => chat().session,
    (query) => live.agent.files(query),
  ),
  start: (options, store) =>
    opencode.start(options).then((agent) => {
      // opencode tells its lists, the model the session runs and its saved rules once asked.
      for (const list of ["models", "rules", "commands", "skills", "mcp", "plugins"] as const) agent.refresh(list)
      return {
        agent,
        hooks: {},
        // The cut goes in at the oldest prompt the store hides.
        goBack: () => agent.goBack(hiddenPrompts(store.state).at(-1) ?? null),
      }
    }),
  hearsShells: false,
  clears: false,
}
const codex = codexKind()
const codexRunner: Runner = {
  kind: codex,
  provider: listedProvider(
    () => chat().session,
    (query) => live.agent.files(query),
  ),
  start: (options, store) =>
    codex.start(options).then((agent) => {
      // Codex tells its lists once asked; the skills come with the commands.
      for (const list of ["modes", "models", "commands", "mcp", "plugins", "hooks"] as const) agent.refresh(list)
      // The cut goes in at the oldest prompt the store hides.
      return { agent, hooks: {}, goBack: () => agent.goBack(hiddenPrompts(store.state).at(-1) ?? null) }
    }),
  hearsShells: false,
  clears: false,
}
// The agents YellowCode can run, Claude first.
const runners: Runner[] = [claudeRunner, opencodeRunner, codexRunner]
const installed = createRegistry(runners.map((runner) => runner.kind))

function runnerOf(ref: SessionRef): Runner {
  const runner = runners.find((candidate) => candidate.kind.id === ref.agent)
  if (!runner) throw new Error(`no installed agent ${ref.agent}`)
  return runner
}

// One that cannot tell counts as not installed.
const detect = (kind: Runner["kind"]): Promise<Detection> =>
  kind.detect().catch((error: unknown) => {
    log.warn(`${kind.id} detection failed`, String(error))
    return { installed: false }
  })

const runnerById = (id: AgentKindId | undefined) => runners.find((runner) => runner.kind.id === id)

// The saved default agent when it runs here, else the first that does, with a notice saying why the saved one did not
// open. With none running, Claude starts and says why it cannot.
async function pickFirst(): Promise<{ runner: Runner; notice: string | null }> {
  const found = new Map<AgentKindId, Detection>()
  const runsHere = async (runner: Runner) => {
    const detection = await detect(runner.kind)
    found.set(runner.kind.id, detection)
    return detection.installed && detection.blocked === null
  }
  const first = await pickAgent(
    stored.defaultAgent,
    runners.map((runner) => runner.kind.id),
    (id) => runsHere(runnerById(id) ?? claudeRunner),
  )
  const candidate = runnerById(first) ?? claudeRunner
  // pickAgent leaves the last candidate unasked; only Claude starts unchecked.
  const runner =
    candidate === claudeRunner || found.has(candidate.kind.id) || (await runsHere(candidate)) ? candidate : claudeRunner
  const saved = runnerById(stored.defaultAgent)
  const why = saved && saved !== runner ? found.get(saved.kind.id) : undefined
  const reason = why === undefined ? null : why.installed ? why.blocked : "is not installed"
  return {
    runner,
    notice: saved && reason !== null ? `${saved.kind.name} ${reason} · opened ${runner.kind.name}` : null,
  }
}

// A replay is a Claude recording.
const picked = values.replay === undefined ? await pickFirst() : { runner: claudeRunner, notice: null }
const firstRunner = picked.runner
await startMods(values["no-mods"], {
  id: firstRunner.kind.id,
  name: firstRunner.kind.name,
  caps: firstRunner.kind.caps,
})

async function startLive(runner: Runner, options: StartOptions, store: SessionStore): Promise<Live> {
  const { agent, hooks, goBack } = await runner.start(options, store)
  void follow(agent.events, store, runner.kind.name)
  return { runner, agent, store, hooks, goBack }
}

// The agent of the moment, compared by identity: Claude's changes with each claude its agent starts.
const runOf = (running: Live) => running.hooks.run ?? running.agent

// An agent starts with the saved thinking display and mode, and its own model and effort.
const startOptions = (runner: Runner, resume: StartOptions["resume"]): StartOptions => ({
  cwd,
  resume,
  mode: null,
  defaultMode: defaultModeOf(runner.kind.id),
  model: null,
  effort: null,
  extraEffort: false,
  thinking: settings.thinking !== "hidden",
  instructions: [],
  clientTools: clientTools(),
  // Claude takes the mods' servers on its own path (syncModServers).
  mcpServers: runner.kind.caps.mcpServers === "start" ? mods.launches() : [],
})

// What the agent is given beside its own tools: the mods' tools of the moment, and the tools for the other sessions.
function clientTools(): ClientTool[] {
  return [...mods.clientTools(), ...(peers?.tools ?? [])]
}

// An agent that takes tools mid-session gets the mods' tools of the moment.
function giveTools(target: Live, tools = clientTools()): void {
  if (target.agent.caps.clientTools !== "live") return
  void target.agent.setClientTools(tools).then((done) => {
    if (!done.ok) log.warn(`${target.runner.kind.id} did not take the mods' tools`, done.problem)
  })
}

// A restarted session goes on in the mode it was in, unless the user picked a saved mode since (see modePicked).
const restartOptions = (): RestartOptions => ({
  mode: modePicked ? defaultModeOf(live.runner.kind.id) : null,
  defaultMode: defaultModeOf(live.runner.kind.id),
  thinking: settings.thinking !== "hidden",
})

// Agents asked to close that may still run, with the promise of each being gone.
const stopped = new Map<Agent, Promise<void>>()

function stop(old: Agent): Promise<void> {
  let gone = stopped.get(old)
  if (!gone) {
    gone = old.close().finally(() => stopped.delete(old))
    stopped.set(old, gone)
  }
  return gone
}

// Ends what feeds the chat: the live agent, or the replay.
function closeSource(): void {
  if (mode.kind === "live") void stop(live.agent)
  else void mode.replay.close()
}

async function liveMode() {
  try {
    // Live shows the model and effort the agent reports, and nothing until it does.
    setKnobs({ model: null, effort: null, ultracode: false })
    live = await startLive(firstRunner, startOptions(firstRunner, null), firstSession)
    return { kind: "live" as const, first: live }
  } catch (error) {
    const { id, name } = firstRunner.kind
    return fail(`Cannot start ${id}: ${error instanceof Error ? error.message : String(error)}. Is ${name} installed?`)
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

// Live sessions on this machine see this one and can message it; a replay takes no part.
const peers =
  values.replay === undefined
    ? await startPeers(cwd, {
        session: null,
        agent: firstRunner.kind.id,
        title: "",
        model: "",
        status: "idle",
        hidden: false,
      }).catch((error: unknown) => {
        log.warn("cannot open the session inbox", error)
        return null
      })
    : null
const mode = values.replay === undefined ? await liveMode() : await replayMode(values.replay)
// Snapshots of the project around each prompt, for rewinding its files; a replay touches no files.
const capture = mode.kind === "live" ? createCapture(cwd) : null
// Asks the first agent, even when another session runs by the time the snapshots are ready.
if (mode.kind === "live" && capture) {
  const { first } = mode
  void pruneAtStart(capture.snapshots, () => first.hooks.sessionDays?.() ?? Promise.resolve(null))
}
let unfollow = capture?.follow(firstSession)
const fileRewind = createFileRewind(capture, cwd)
const preview = livePreview(capture, cwd, (session) => fileRewind.pending(session))
const firstInfo = mode.kind === "replay" ? recordedInfo(mode.recording) : null
const firstServers = firstInfo && mcpRows(firstInfo.mcpServers, firstInfo.tools)
const firstModel = firstInfo?.model ?? null
const readOnlyProvider = mode.kind === "live" ? savedProvider(claudeLists) : mode.provider
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
  // Files stay as a rewind left them, and the agent hears nothing of it.
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
  peers?.close()
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
  if (mode.kind === "live") live.hooks.begin?.()
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
// What the main App shows: the session the agent runs (or the replay's), and, once resumed, its transcript.
const [chat, setChat] = createSignal<{ session: SessionStore; resumed: View | null }>({
  session: firstSession,
  resumed: null,
})
// The kind of the agent that runs now; another agent's session changes it.
const [runningKind, setRunningKind] = createSignal(firstRunner.kind.id)
// A mode picked after the agent last said which one it uses wins at a restart: the agent may never have applied it
// (picked while it was down or restarting, Claude's bypassPermissions without the allow flag).
let modePicked = false
createRoot(() => {
  createEffect(
    on([runningKind, () => defaultModeOf(runningKind())], ([kind], before) => {
      // Another agent starts with its own saved mode; nothing was picked for it.
      if (before?.[0] === kind) modePicked = true
    }),
  )
  createEffect(
    on(
      () => chat().session.state.permissionMode,
      () => (modePicked = false),
      { defer: true },
    ),
  )
  createEffect(() => peers?.update({ hidden: settings.peerVisible === "no" }))
  createEffect(() => {
    if (!peers || mode.kind !== "live") return
    const { state } = chat().session
    peers.update({
      session: state.info?.id ?? (live.agent.session.id || null),
      agent: runningKind(),
      model: state.info?.model ?? "",
      status: state.status === "idle" ? "idle" : "busy",
    })
  })
  createEffect(
    on(
      () => clientTools(),
      (tools) => {
        if (mode.kind === "live") giveTools(live, tools)
      },
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

// A turn that runs keeps the session it belongs to; background tasks alone stop, as on quit. `then` is what waits.
function working(then = "open the session"): boolean {
  const { name } = live.runner.kind
  // A restart that waits for the old claude to end sends the typed message once it has started.
  if (live.hooks.restarting) setControlProblem({ text: `${name} is starting again · ${then} once it runs` })
  else if (live.store.state.status === "running")
    setControlProblem({ text: `${name} is working · Esc interrupts it, then ${then}` })
  else return false
  return true
}

// Sessions of different agents may share an id.
const sameSession = (a: SessionRef, b: SessionRef) => a.agent === b.agent && a.id === b.id

// Continues a session of this project in place, or as a copy when another process runs it (two writers on one file).
async function openLive(entry: SessionEntry): Promise<void> {
  const current = live
  const run = runOf(current)
  const { ref } = entry
  if (sameSession(ref, current.agent.session) || working()) return
  const token = ++opening
  const runner = runnerOf(ref)
  const { kind } = runner
  const part = await kind.history(ref, null)
  if (quitting) return
  // A session left a moment ago may still be writing its file.
  await Promise.all([...stopped].flatMap(([old, gone]) => (sameSession(old.session, ref) ? [gone] : [])))
  if (quitting || token !== opening || runOf(live) !== run || working()) return
  const copy = kind.heldElsewhere ? await kind.heldElsewhere(ref) : false
  if (quitting || token !== opening || runOf(live) !== run || working()) return
  await modsFor(kind)
  if (quitting || token !== opening || runOf(live) !== run || working()) return void modsFor(live.runner.kind)
  const session = createSession({ starting: true })
  session.prepend(part.events)
  const following = capture?.follow(session)
  // Prompts made in the agent itself rewind the files they changed from its own backups.
  if (kind.caps.features.includes("fileHistory"))
    capture?.adopt(ref.id, (wanted) => kind.fileHistory?.(ref, wanted) ?? Promise.resolve([]))
  let next: Live
  try {
    next = await startLive(runner, startOptions(runner, { ref, fork: copy, at: null }), session)
  } catch (error) {
    log.error(`cannot start ${kind.id}`, error)
    following?.()
    void modsFor(live.runner.kind)
    setControlProblem({ text: `Cannot start ${kind.name}: ${error instanceof Error ? error.message : String(error)}` })
    return
  }
  if (quitting || token !== opening || runOf(live) !== run) {
    void next.agent.close()
    following?.()
    void modsFor(live.runner.kind)
    return
  }
  const [earlier, setEarlier] = createSignal(part.earlier)
  replaceLive(current, next, following, { entry, session, earlier, setEarlier })
  if (copy) setControlProblem({ text: "This session is open in another process, so it opened as a copy" })
}

// The next session takes the screen in place of the current one, whose agent closes.
function replaceLive(current: Live, next: Live, following: (() => void) | undefined, resumed: View | null): void {
  // Its background agents may write until its agent is gone, and those writes still go to its prompts.
  const left = unfollow
  unfollow = following
  void stop(current.agent).finally(() => left?.())
  fileRewind.release()
  // Opening another session starts from the agent's own model and effort.
  setKnobs({ model: null, effort: null, ultracode: false })
  live = next
  setRunningKind(next.runner.kind.id)
  // The mods may have changed while it started.
  giveTools(next)
  next.hooks.begin?.()
  setChat({ session: next.store, resumed })
}

// A new session of another agent; the one left stays in /resume.
async function switchAgent(id: AgentKindId): Promise<void> {
  const runner = runnerById(id)
  if (runner && runner !== live.runner) await startNew(runner, "switch the agent")
}

// A /clear on an agent with none of its own: a new session of the same agent, the one left stays in /resume.
function clearLive(): boolean {
  if (working("start a new session")) return false
  startNew(live.runner, "start a new session").catch((error: unknown) => log.error("cannot start a new session", error))
  return true
}

// A new session of the agent takes the screen; `then` is what waits for a running turn.
async function startNew(runner: Runner, then: string): Promise<void> {
  const current = live
  const run = runOf(current)
  if (working(then)) return
  const token = ++opening
  // The mods load for the agent before it starts, so it starts with their tools.
  await modsFor(runner.kind)
  if (quitting || token !== opening || runOf(live) !== run || working(then)) return void modsFor(live.runner.kind)
  const session = createSession({ starting: true })
  const following = capture?.follow(session)
  let next: Live
  try {
    next = await startLive(runner, startOptions(runner, null), session)
  } catch (error) {
    log.error(`cannot start ${runner.kind.id}`, error)
    following?.()
    void modsFor(live.runner.kind)
    setControlProblem({
      text: `Cannot start ${runner.kind.name}: ${error instanceof Error ? error.message : String(error)}`,
    })
    return
  }
  if (quitting || token !== opening || runOf(live) !== run) {
    void next.agent.close()
    following?.()
    void modsFor(live.runner.kind)
    return
  }
  replaceLive(current, next, following, null)
}

// The last look at the installed agents, for /agent and the default agent.
const [agentChoices, setAgentChoices] = createSignal<AgentChoice[] | null>(null)
let detecting: Promise<AgentChoice[]> | null = null

// The running agent is listed even when its binary no longer answers.
function detectAgents(): Promise<AgentChoice[]> {
  detecting ??= Promise.all(
    runners.map(async ({ kind }): Promise<AgentChoice[]> => {
      const found = await detect(kind)
      const { id, name } = kind
      if (found.installed) return [{ id, name, version: found.version, blocked: found.blocked }]
      return kind === live.runner.kind ? [{ id, name, version: live.agent.version, blocked: null }] : []
    }),
  )
    .then((lists) => {
      const choices = lists.flat()
      setAgentChoices(choices)
      return choices
    })
    .finally(() => (detecting = null))
  return detecting
}

const agents = {
  known: runners.map(({ kind }) => ({ id: kind.id, name: kind.name })),
  installed: agentChoices,
  detect: detectAgents,
  pick: (id: AgentKindId) => void switchAgent(id).catch((error: unknown) => log.error("cannot switch agent", error)),
}

// The live agent whose restart was refused for good; Enter no longer offers one for it.
const [restartRefused, setRestartRefused] = createSignal<Live | null>(null)

// The agent went away on its own: a new process continues the same conversation, and the message goes to it. A claude
// that stopped responding can still be running out its grace, so its agent waits for it, and Enter again only refuses
// to send.
function restart(message: Message, giveBack: () => void): boolean {
  if (quitting) return false
  const target = live
  const restarted = target.hooks.restartNow
    ? target.hooks.restartNow(restartOptions())
    : target.agent.restart(restartOptions())
  // Nothing had to wait: a claude that cannot be started leaves the message in the prompt.
  if (!(restarted instanceof Promise)) {
    if (!restarted.ok) return false
    relaunch(target, message, giveBack)
    return true
  }
  void restarted.then((done) => {
    if (done.ok) return relaunch(target, message, giveBack)
    log.warn("the restarted agent took no message", done.problem)
    // The chat already says why. Claude's restart can be tried again; another agent's refusal stands for the session.
    if (!target.hooks.restartNow) setRestartRefused(target)
    giveBack()
  })
  return true
}

function relaunch(target: Live, message: Message, giveBack: () => void): void {
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
  target: Live,
  message: Message,
  giveBack?: () => void,
  kept: string[] = [],
  // Goes after the message, so Claude Code does not name things (a plan file) after it.
  shells: Prompt["shells"] = [],
): void {
  // A send makes a rewind final, so /redo has nothing to bring back.
  fileRewind.release()
  const uuid = crypto.randomUUID()
  const { store: session } = target
  const command = message.to === null ? commandOf(message.text, session.lists().commands) : null
  const prompt: Prompt = { ...message, id: uuid, command, delivery: "steer", kept, shells }
  const run = runOf(target)
  const startsTurn = session.state.status !== "running"
  const show = target.runner.show ?? showEarly
  show(session, prompt)
  const ready = capture?.before(uuid, target.agent.session.id || null, session)
  const unsent = () => {
    capture?.drop(uuid)
    session.notSent(uuid)
    giveBack?.()
  }
  sending = sending
    .then(() => ready)
    .then(() => {
      // An agent started since (a restart, another session) is not the one the message was typed for.
      if (runOf(live) !== run) {
        log.warn("the agent changed before the message went out; dropped it")
        return unsent()
      }
      return target.agent.send(prompt).then((sent) => {
        if (sent.ok) return
        unsent()
        setControlProblem({ text: sent.problem })
      })
    })
    .catch((error: unknown) => log.error("cannot send the message", error))
  if (startsTurn) turnSend = sending
}

// With "Ask first" a message waits for the user, asked the way a permission is.
peers?.holdWith((id, message) => {
  if (settings.peerMessages !== "ask") return false
  live.store.event({ type: "ask.open", ask: peerAsk(id, message), at: Date.now() })
  return true
})

// A broadcast to every session on the machine goes out only once the user lets it.
const everywhereWaiting = new Map<string, (yes: boolean) => void>()
peers?.confirmWith((message) => {
  const id = crypto.randomUUID()
  live.store.event({ type: "ask.open", ask: everywhereAsk(id, message), at: Date.now() })
  return new Promise((resolve) => everywhereWaiting.set(id, resolve))
})

function answerEverywhere(id: string, ask: { requestId: string }, reply: AskReply): void {
  const yes = reply.type === "option" && reply.option === "send"
  live.store.event({
    type: "ask.close",
    id: ask.requestId,
    outcome: yes ? { status: "allowed" } : { status: "denied", said: "", why: "declined", note: "" },
    at: Date.now(),
  })
  everywhereWaiting.get(id)?.(yes)
  everywhereWaiting.delete(id)
}

function answerHeld(id: string, ask: { requestId: string }, reply: AskReply): void {
  const run = reply.type === "option" && reply.option !== "decline"
  if (reply.type === "option" && reply.option === "always") setSessionSettings({ peerMessages: "run" })
  live.store.event({
    type: "ask.close",
    id: ask.requestId,
    outcome: run ? { status: "allowed" } : { status: "denied", said: "", why: "declined", note: "" },
    at: Date.now(),
  })
  peers?.release(id, run)
}

// A message from another session goes out as a prompt of the session running now.
peers?.sendWith((message) => {
  const text = sessionMessage({ ...message.from, broadcast: message.broadcast, text: message.text })
  return sendLive({ text, images: message.images, to: null }, () => {})
})

const [goingBack, setGoingBack] = createSignal(false)

// False when the live agent cannot take the message.
function sendLive(message: Message, giveBack: () => void): boolean {
  if (live.hooks.accepts?.() === false) return false
  // The prompt clears once this returns; a chat item before that would take the welcome screen's draft with it.
  sendRewound(live, message, giveBack)
  return true
}

// The prompt is already cleared when this runs, so a failure gives the text back.
function sendRewound(target: Live, message: Message, giveBack: () => void): void {
  void queueRewind(() => sendAfterRewinds(target, message, giveBack)).catch((error: unknown) => {
    log.error("cannot send after the rewind", error)
    giveBack()
    setControlProblem({ text: "The message did not go out" })
  })
}

// A message goes out after the rewinds before it: the conversation goes back to the rewound prompt first, and the
// chat shows the message only then. A restart keeps the session.
async function sendAfterRewinds(target: Live, message: Message, giveBack: () => void) {
  const session = target.store
  const steps = hiddenPrompts(session.state).length > 0
  const { goBack } = target
  if (steps && goBack) setGoingBack(true)
  const back = goBack ? await goBack().finally(() => setGoingBack(false)) : { ok: true as const }
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

// `!` commands the agent has yet to read; they go out with the next message.
let untoldShells: { session: SessionStore; shells: Prompt["shells"] } | null = null

// A replay sends nothing, so its commands are told from the start.
function runShellCommand(session: SessionStore, command: string): void {
  // An agent that does not hear them has nothing to be told.
  const told = mode.kind !== "live" || !live.runner.hearsShells
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
function cutConversation(target: Live, rewound: Rewound): void {
  const item = target.store.state.byId[rewound.userId]
  if (item?.kind !== "user" || item.uuid === undefined) return log.warn("rewound prompt has no id; its task turns show")
  void target.agent.cut(item.uuid).then((done) => {
    if (!done.ok) log.warn("cut refused", done.problem)
  })
}

// Enter in the rewind dialog: the background tasks the rewound prompts started stop, their files go back, and only
// then does the session rewind. False when the files could not be touched and nothing was rewound; the ⚠ paths and
// files when they changed since the dialog showed them, so it asks again.
async function rewindLive(target: Live, rewound: Rewound, seen: string[]): Promise<boolean | RewindRecheck> {
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
      target.agent.tasks.stop(task.id).then((done) => {
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
  // The files did not go back, so the cut that already went out is taken back (a no-op on Claude). An earlier rewind
  // still pending is staged again by goBack on the next send.
  if (files.kind === "failed" || files.kind === "changed") void target.agent.undoCut()
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
async function redoLive(target: Live): Promise<void> {
  const files = await fileRewind.redo(target.store.state)
  log.info("redo files", files.kind === "done" ? { changed: files.paths.length, kept: files.kept.length } : files)
  target.store.redo()
  const undone = await target.agent.undoCut()
  const notUndone = undone.ok ? null : undone.problem
  if (files.kind === "failed") noticeRewind(sentences([`Cannot bring the files back: ${files.reason}`, notUndone]))
  else noticeRewind(sentences([files.kind === "done" ? keptNotice(files.kept) : null, notUndone]))
}

// The session is the App's own; a title for a session left meanwhile is dropped.
function rename(session: SessionStore, title: string): void {
  if (session === live.store) void live.agent.rename(title)
}

async function loadEarlier(shown: View): Promise<void> {
  const cursor = shown.earlier()
  if (cursor === null) return
  const part = await installed.kindOf(shown.entry.ref).history(shown.entry.ref, cursor)
  shown.session.prepend(part.events)
  shown.setEarlier(part.earlier)
}

// The agents whose sessions /resume and Recent list: those the last look found usable, or a new look. A replay lists
// Claude's.
async function listedKinds(): Promise<SessionKind[]> {
  if (mode.kind !== "live") return [claude]
  const found = agentChoices() ?? (await detectAgents())
  return runners.flatMap(({ kind }) =>
    found.some((choice) => choice.id === kind.id && choice.blocked === null) ? [kind] : [],
  )
}

const sessions = {
  // The session the agent runs is not one to open. Until the agent reports it, that is the one it was started with;
  // after that the App leaves out the id the session reports, which a /clear changes.
  list: async () => {
    const kinds = await listedKinds()
    const entries = await createRegistry(kinds).sessions(cwd, mode.kind === "live" ? live.runner.kind.id : null)
    const starting = mode.kind === "live" && live.store.state.info === null ? live.agent.session : undefined
    return {
      entries: entries.filter((entry) => !starting || !sameSession(entry.ref, starting)),
      // With one agent listed the rows stay as they were, without a name.
      names: kinds.length > 1 ? Object.fromEntries(kinds.map((kind) => [kind.id, kind.shortName ?? kind.name])) : null,
    }
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
              agent={mode.kind === "live" ? live.runner.kind : claude}
              caps={mode.kind === "live" ? live.agent.caps : mode.replay.caps}
              model={() => current.session.state.info?.model ?? firstModel}
              firstInfo={firstInfo}
              firstServers={firstServers}
              lists={current.session.lists}
              workspace={workspace}
              replay={mode.kind === "replay" ? mode.info : null}
              title={
                current.resumed
                  ? { title: current.resumed.entry.title, summary: current.resumed.entry.firstPrompt }
                  : undefined
              }
              oneShot={
                mode.kind === "live" ? live.runner.kind.oneShot : values.titles === true ? claude.oneShot : undefined
              }
              // The App before it showed the settings file's problem already.
              settingsProblem={current.resumed ? null : problem}
              settingsBackup={current.resumed ? null : backup}
              provider={mode.kind === "live" ? live.runner.provider : mode.provider}
              extensions={mode.kind === "live" ? extensions : undefined}
              sessions={sessions}
              agents={mode.kind === "live" ? agents : undefined}
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
              onClear={mode.kind === "live" && !live.runner.clears ? clearLive : undefined}
              onRestart={
                mode.kind === "live" && live.agent.caps.restart && restartRefused() !== live && !live.store.state.final
                  ? restart
                  : undefined
              }
              onAnswer={(ask, reply) => {
                const held = heldOf(ask.requestId)
                if (held !== null) return answerHeld(held, ask, reply)
                const everywhere = everywhereOf(ask.requestId)
                if (everywhere !== null) return answerEverywhere(everywhere, ask, reply)
                if (ask.ownPlan) return current.session.settlePlan(ask.requestId, reply)
                void (mode.kind === "replay" ? mode.replay : live.agent).answer(ask.requestId, reply)
              }}
              onQuit={() => void quit()}
              onShell={(command) => runShellCommand(current.session, command)}
              onShellStop={() => shellRun?.stop()}
              onInterrupt={
                mode.kind === "live"
                  ? () => {
                      // The interrupt waits for a message that starts the turn, but the chat shows it at once.
                      current.session.interrupting()
                      const asked = live.agent
                      void turnSend.then(() => asked.interrupt())
                    }
                  : undefined
              }
              tasks={mode.kind === "live" ? taskActions : undefined}
              onTitle={mode.kind === "live" ? (title) => rename(current.session, title) : undefined}
              onShownTitle={mode.kind === "live" ? (title) => peers?.update({ title }) : undefined}
              knobs={mode.kind === "live" ? knobs : undefined}
              info={mode.kind === "live" ? infoReads : undefined}
              permissions={
                mode.kind === "live"
                  ? {
                      rules: () => current.session.lists().rules ?? null,
                      refresh: () => live.agent.refresh("rules"),
                      remove: (id) => live.agent.permissions.remove(id),
                    }
                  : undefined
              }
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
                  : // Without a cut the agent would keep the rewound turns, so nothing is rewound.
                    live.agent.caps.cut
                    ? {
                        preview: (session, selected) => rewinding.then(() => preview(session, selected)),
                        offReason: () => capture?.offReason(),
                        working: () => rewindWork() > 0,
                        goingBack,
                        onRewind: (rewound, seen) => {
                          log.info("rewind", { prompts: rewound.prompts, keptFiles: rewound.keptFiles })
                          const target = live
                          if (rewound.keptFiles)
                            return queueRewind(() => {
                              cutConversation(target, rewound)
                              target.store.rewind(rewound)
                              return Promise.resolve(true)
                            })
                          return queueRewind(() => rewindLive(target, rewound, seen)).catch(() => false)
                        },
                        onRedo: () => {
                          const target = live
                          void queueRewind(() => redoLive(target)).catch((error: unknown) => {
                            log.error("redo failed", error)
                            noticeRewind("Cannot bring the conversation back")
                          })
                        },
                      }
                    : undefined
              }
            />
          )}
        </Show>
      }
    >
      {(shown) => (
        <App
          session={shown.session.state}
          lists={shown.session.lists}
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

// Why the saved default agent did not open, once the App shows.
function tellPicked(): void {
  if (picked.notice !== null) setControlProblem({ text: picked.notice })
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
            tellPicked()
          }}
          onQuit={() => void quit()}
        />
      )}
    </Show>
  ),
  renderer,
)
if (terminal === null) tellPicked()
// After the first frame, or a second when the renderer stays busy, so the network never holds up the start.
void Promise.race([renderer.idle(), Bun.sleep(1000)]).then(() => startModUpdates(values["no-mods"]))
