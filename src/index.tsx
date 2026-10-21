import { CliRenderEvents, createCliRenderer, destroyTreeSitterClient } from "@opentui/core"
import { render } from "@opentui/solid"
import { existsSync, realpathSync } from "node:fs"
import { constants, homedir } from "node:os"
import { basename, join } from "node:path"
import { parseArgs } from "node:util"
import { type Accessor, createEffect, createRoot, createSignal, on, type Setter, Show } from "solid-js"
import { type InputProvider, liveProvider, replayProvider } from "./input/provider.ts"
import { log } from "./log/log.ts"
import { parse } from "./protocol/parse.ts"
import { permissionReply } from "./protocol/messages.ts"
import { interruptRequest, type OutgoingImage, renameSession, userMessage } from "./protocol/outgoing.ts"
import { heldElsewhere } from "./resume/held.ts"
import { CLAUDE_PROJECTS, projectFolder } from "./resume/project-key.ts"
import { listSessions, type SessionEntry } from "./resume/session-list.ts"
import { loadTranscript, readTranscript, type TranscriptCursor } from "./resume/transcript.ts"
import { createSession, type SessionStore } from "./session/session.ts"
import { initSettings, setControlProblem, setKnobs, settings } from "./session/settings.ts"
import { loadSettings, savedMode } from "./session/settings-file.ts"
import { stopTitles } from "./session/titler.ts"
import packageJson from "../package.json"
import { loadRewindExtras } from "./session/rewind.ts"
import { connect, type Connection, pump } from "./source/live.ts"
import { loadRecording, RecordingError, recordedInfo } from "./source/recording.ts"
import { createReplaySource, parseSpeed } from "./source/replay.ts"
import type { Requests } from "./source/requests.ts"
import { readTerminal } from "./theme/palette.ts"
import { setTerminal, startTheme } from "./theme/theme.ts"
import { App } from "./ui/app.tsx"
import type { McpActions } from "./ui/mcp/mcp-tab.tsx"
import type { PluginActions } from "./ui/settings/plugins-tab.tsx"
import type { SkillActions } from "./ui/skills/skills-dialog.tsx"
import { noteKey } from "./ui/ask/typing.ts"
import { invertQueued } from "./ui/invert.ts"
import { firstCapabilities, TerminalCheck, terminalProblem } from "./ui/terminal-check.tsx"

const USAGE = [
  "Usage: yellowcode [--sessions <folder>] [--skip-terminal-check]",
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

function gitBranch(): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: process.cwd(), stderr: "ignore" })
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

// The session claude runs: the id it reported, else the one it was started with.
const idOf = (live: Connection) => live.session.state.info?.id ?? live.spawn.sessionId ?? live.spawn.resume

function liveMode() {
  try {
    // Live shows the model and effort claude reports, and nothing until it does.
    setKnobs({ model: null, effort: null, ultracode: false })
    // A new session gets its id from here, so it is known before claude reports it.
    const spawn = { sessionId: crypto.randomUUID() }
    connection = connect({ cwd, session: firstSession, spawn, stored: settings, provider: claudeLists })
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
  return { kind: "replay" as const, source, recording, info, provider, rewindExtras: await loadRewindExtras(file) }
}

const mode = values.replay === undefined ? liveMode() : await replayMode(values.replay)
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
process.on("uncaughtException", (error) => log.error("uncaught exception", error))
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", reason))
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
// Each close() is bounded on its own; this bounds the quit as a whole.
const QUIT_WAIT_MS = 8000

async function quit(code = 0): Promise<void> {
  if (quitting) return
  quitting = true
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
    if (mode.kind === "live") await Promise.race([Promise.all(stopped.values()), Bun.sleep(QUIT_WAIT_MS)])
    process.exit(code)
  }
}

// The renderer handles these by tearing itself down without exiting, so they quit the app.
const QUIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT", "SIGPIPE", "SIGBUS"] as const

process.on("exit", () => {
  source.close()
  stopTitles()
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
  let next: Connection
  try {
    next = connect({ cwd, session, spawn, stored: settings, provider: claudeLists })
  } catch (error) {
    log.error("cannot start claude", error)
    setControlProblem({ text: `Cannot start Claude Code: ${error instanceof Error ? error.message : String(error)}` })
    return
  }
  void stop(current)
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
function restart(text: string, images: OutgoingImage[]): boolean {
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
      if (!relaunch(ended, text, images)) log.warn("the restarted claude took no message")
    })
    return true
  }
  void stop(ended)
  return relaunch(ended, text, images)
}

// False when no claude took the message, so the prompt keeps it.
function relaunch(ended: Connection, text: string, images: OutgoingImage[]): boolean {
  if (quitting || connection !== ended) return false
  const { session } = ended
  const id = session.state.info?.id
  // With nothing on disk the start is repeated, under a new id in case claude took the old one.
  const again = ended.spawn.sessionId ? { ...ended.spawn, sessionId: crypto.randomUUID() } : ended.spawn
  const spawn =
    id !== undefined && existsSync(join(projectFolder(CLAUDE_PROJECTS, cwd), `${id}.jsonl`)) ? { resume: id } : again
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
  return source.send(userMessage(text, images, crypto.randomUUID()))
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
              onSubmit={(text, images) => {
                // A recording has no lifecycle lines to settle a uuid, so a replay sends none.
                const uuid = mode.kind === "live" ? crypto.randomUUID() : undefined
                if (!text.trim() && images.length === 0) {
                  // An empty Enter releases the next recorded message.
                  if (mode.kind === "replay") source.send("")
                  return true
                }
                // A knob change still waiting goes first, so the message runs under it.
                if (mode.kind === "live") connection.controls.flush()
                return source.send(userMessage(text, images, uuid))
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
                current.session.answer(response)
                source.send(response)
              }}
              onQuit={() => void quit()}
              onInterrupt={
                requests
                  ? () =>
                      void requests.send(interruptRequest).then(
                        (reply) => log.info("interrupted", reply),
                        (error: unknown) => {
                          log.warn("interrupt failed", error instanceof Error ? error.message : error)
                          current.session.interruptFailed()
                        },
                      )
                  : undefined
              }
              onTitle={requests ? (title) => rename(requests, current.session, title) : undefined}
              onStopTask={mode.kind === "live" ? (taskId) => connection.tasks.stop(taskId) : undefined}
              rewind={
                mode.kind === "replay"
                  ? {
                      extras: mode.rewindExtras,
                      // Restoring files and respawning claude at the prompt wait for the live connection.
                      onRewind: (rewound) => {
                        log.info("rewind", rewound)
                        current.session.rewind(rewound)
                      },
                      onRedo: () => current.session.redo(),
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
