import { CliRenderEvents, createCliRenderer, destroyTreeSitterClient } from "@opentui/core"
import { render } from "@opentui/solid"
import { realpathSync } from "node:fs"
import { constants, homedir } from "node:os"
import { basename } from "node:path"
import { parseArgs } from "node:util"
import { type Accessor, createSignal, type Setter, Show } from "solid-js"
import { liveProvider, replayProvider } from "./input/provider.ts"
import { log } from "./log/log.ts"
import { parse } from "./protocol/parse.ts"
import { initializeModels, initializeResponse, permissionReply } from "./protocol/messages.ts"
import { initializeRequest, interruptRequest, userMessage } from "./protocol/outgoing.ts"
import { CLAUDE_PROJECTS, projectFolder } from "./resume/project-key.ts"
import { listSessions, type SessionEntry } from "./resume/session-list.ts"
import { loadTranscript, readTranscript, type TranscriptCursor } from "./resume/transcript.ts"
import { ownAskRejection } from "./session/ask.ts"
import { createSession, type SessionStore } from "./session/session.ts"
import { initSettings, settings } from "./session/settings.ts"
import { loadSettings } from "./session/settings-file.ts"
import { stopTitles } from "./session/titler.ts"
import packageJson from "../package.json"
import { loadRewindExtras } from "./session/rewind.ts"
import { createClaudeSource, describeExit } from "./source/claude.ts"
import { loadRecording, RecordingError, recordedInfo } from "./source/recording.ts"
import { createReplaySource, parseSpeed } from "./source/replay.ts"
import { createRequests, refusal, type Requests, RequestTimeout } from "./source/requests.ts"
import { readTerminal } from "./theme/palette.ts"
import { setTerminal, startTheme } from "./theme/theme.ts"
import { App } from "./ui/app.tsx"
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
const session = createSession({ starting: values.replay === undefined })

function liveMode() {
  try {
    // claude ends on closed input only once its turn and its background tasks are done.
    const busy = () =>
      session.state.status === "running" || Object.values(session.state.tasks).some((task) => task.state === "running")
    const source = createClaudeSource(cwd, busy)
    return { kind: "live" as const, source }
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
  return { kind: "replay" as const, source, recording, info, rewindExtras: await loadRewindExtras(file) }
}

const mode = values.replay === undefined ? liveMode() : await replayMode(values.replay)
const source = mode.source
// A replay answers from its recording, and a request sent to it would release its gate instead.
const requests = mode.kind === "live" ? createRequests((line) => source.send(line)) : null
const firstInfo = mode.kind === "replay" ? recordedInfo(mode.recording) : null
const firstModel = firstInfo?.model ?? null
const provider = mode.kind === "replay" ? replayProvider(mode.recording) : liveProvider()
const { settings: stored, problem, backup } = loadSettings()
initSettings(stored)
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
// close() stops claude within its own timers; this also covers a process claude started that keeps the pipes open.
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
    if (mode.kind === "live") await Promise.race([mode.source.exited, Bun.sleep(QUIT_WAIT_MS)])
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

const INVALID_LOG_EVERY = 100
const EXIT_WAIT_MS = 3000
const INITIALIZE_TIMEOUT_MS = 60_000

// What claude offers before the first message (system/init only comes with it). The reply also names the account,
// so only counts are logged.
const initialized = Promise.withResolvers<unknown>()
// A claude that stays silent through initialize is closed, and its end says why.
let silent = false

function initialize(live: Requests): void {
  const started = performance.now()
  void live.send(initializeRequest, INITIALIZE_TIMEOUT_MS).then(
    (reply) => {
      log.info("initialized", {
        commands: initializeResponse.safeParse(reply).data?.commands.length ?? 0,
        models: initializeModels.safeParse(reply).data?.models.length ?? 0,
        ms: Math.round(performance.now() - started),
      })
      initialized.resolve(reply)
    },
    (error: unknown) => {
      log.warn("initialize failed", error instanceof Error ? error.message : error)
      initialized.resolve(null)
      if (!(error instanceof RequestTimeout)) return
      silent = true
      source.close()
    },
  )
}
const invalidCounts = new Map<string, number>()

async function pump(): Promise<void> {
  if (requests) initialize(requests)
  let yielded = performance.now()
  try {
    for await (const event of source.events) {
      const parsed = parse(event.line)
      if (parsed.kind === "invalid") {
        const count = (invalidCounts.get(parsed.key) ?? 0) + 1
        invalidCounts.set(parsed.key, count)
        if (count === 1) log.warn(`invalid ${parsed.key} message: ${parsed.error}`, parsed.raw)
        else if (count % INVALID_LOG_EVERY === 0) log.warn(`invalid ${parsed.key} messages: ${count} so far`)
      }
      if (parsed.kind === "unknown" && event.dir === "in") log.debug(`unknown message ${parsed.key}`)
      session.apply(event.dir, parsed, event.at)
      if (event.dir === "in" && parsed.kind === "message" && parsed.message.type === "control_response")
        requests?.settle(parsed.message.response)
      if (
        mode.kind === "live" &&
        event.dir === "in" &&
        parsed.kind !== "message" &&
        parsed.key.startsWith("control_request/")
      ) {
        const subtype = parsed.key.slice("control_request/".length)
        const reply = refusal(
          event.line,
          parsed.kind === "unknown"
            ? `YellowCode does not support ${subtype}`
            : `YellowCode could not read this ${subtype} request`,
        )
        if (reply) {
          log.warn(`answered ${parsed.key} with an error`)
          source.send(reply)
        }
      }
      const rejection = event.dir === "in" && parsed.kind === "message" ? ownAskRejection(parsed.message) : null
      if (rejection) {
        log.info("rejected own ask", rejection)
        session.answer(rejection)
        source.send(rejection)
      }
      // Lines that are already waiting arrive without a macrotask, so a burst would not paint until it ends.
      if (performance.now() - yielded > 8) {
        await new Promise((resolve) => setImmediate(resolve))
        yielded = performance.now()
      }
    }
  } catch (error) {
    log.error("source failed", error)
  }
  if (mode.kind === "replay") return session.end()
  requests?.close("Claude Code exited")
  // A process claude started can keep its stderr open after claude itself has gone.
  const exit = await Promise.race([mode.source.exited, Bun.sleep(EXIT_WAIT_MS).then(() => mode.source.exitNow())])
  if (silent)
    session.end({ text: `Claude Code did not answer in ${INITIALIZE_TIMEOUT_MS / 1000} s`, detail: exit.stderr })
  else if (exit.closed) session.end()
  else if (exit.code === null && exit.signal === null) {
    log.warn("claude closed its output but still runs")
    mode.source.close()
    session.end({ text: "Claude Code stopped responding", detail: exit.stderr })
  } else session.end(describeExit(exit))
}

type View = {
  entry: SessionEntry
  session: SessionStore
  earlier: Accessor<TranscriptCursor | null>
  setEarlier: Setter<TranscriptCursor | null>
}

const [view, setView] = createSignal<View | null>(null)
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

async function loadEarlier(shown: View): Promise<void> {
  const cursor = shown.earlier()
  if (cursor === null) return
  const part = await readTranscript(shown.entry.path, cursor)
  shown.session.prepend(part.events)
  shown.setEarlier(part.earlier)
}

const sessions = {
  list: () => listSessions(sessionsFolder, sessionsCwd),
  open: (entry: SessionEntry) => {
    open(entry).catch((error: unknown) => log.error("cannot open session", error))
  },
}

const terminal = values["skip-terminal-check"] ? null : terminalProblem(await capabilities)
if (terminal) log.info("terminal problem", terminal)
const [checking, setChecking] = createSignal(terminal !== null)
if (terminal === null) void pump()

function Main() {
  return (
    <Show
      when={view()}
      keyed
      fallback={
        <App
          session={session.state}
          model={() => session.state.info?.model ?? firstModel}
          firstInfo={firstInfo}
          workspace={workspace}
          replay={mode.kind === "replay" ? mode.info : null}
          titles={mode.kind === "live" || values.titles === true}
          settingsProblem={problem}
          settingsBackup={backup}
          provider={provider}
          sessions={sessions}
          onSubmit={(text, images) => {
            // A recording has no lifecycle lines to settle a uuid, so a replay sends none.
            const uuid = mode.kind === "live" ? crypto.randomUUID() : undefined
            if (text.trim() || images.length > 0) return source.send(userMessage(text, images, uuid))
            // An empty Enter releases the next recorded message.
            if (mode.kind === "replay") source.send("")
            return true
          }}
          onAnswer={(ask, response) => {
            // The reply carries the tool's whole input (a Write's file) and the user's notes, so only its gist is logged.
            const answer = parse(response)
            const reply =
              answer.kind === "message" && answer.message.type === "control_response" ? answer.message : null
            const behavior =
              permissionReply.safeParse(reply?.response.response).data?.behavior ?? reply?.response.subtype
            log.info(`answer to ${ask.toolName}`, { requestId: ask.requestId, behavior })
            session.answer(response)
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
                      session.interruptFailed()
                    },
                  )
              : undefined
          }
          rewind={
            mode.kind === "replay"
              ? {
                  extras: mode.rewindExtras,
                  // Restoring files and respawning claude at the prompt wait for the live connection.
                  onRewind: (rewound) => {
                    log.info("rewind", rewound)
                    session.rewind(rewound)
                  },
                  onRedo: () => session.redo(),
                }
              : undefined
          }
        />
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
          provider={provider}
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
            void pump()
          }}
          onQuit={() => void quit()}
        />
      )}
    </Show>
  ),
  renderer,
)
