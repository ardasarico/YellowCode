import { createCliRenderer, destroyTreeSitterClient } from "@opentui/core"
import { render } from "@opentui/solid"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename } from "node:path"
import { parseArgs } from "node:util"
import { type Accessor, createSignal, type Setter, Show } from "solid-js"
import { replayProvider } from "./input/provider.ts"
import { log } from "./log/log.ts"
import { parse } from "./protocol/parse.ts"
import { userMessage } from "./protocol/outgoing.ts"
import { CLAUDE_PROJECTS, projectFolder } from "./resume/project-key.ts"
import { listSessions, type SessionEntry } from "./resume/session-list.ts"
import { loadTranscript, readTranscript, type TranscriptCursor } from "./resume/transcript.ts"
import { createSession, type SessionStore } from "./session/session.ts"
import { initSettings, settings } from "./session/settings.ts"
import { loadSettings } from "./session/settings-file.ts"
import packageJson from "../package.json"
import { loadRecording, RecordingError, recordedModel } from "./source/recording.ts"
import { createReplaySource, parseSpeed } from "./source/replay.ts"
import { readTerminal } from "./theme/palette.ts"
import { setTerminal, setTheme } from "./theme/theme.ts"
import { App } from "./ui/app.tsx"

const USAGE = "Usage: bun run dev --replay <file.jsonl> [--speed <number|instant>] [--titles] [--sessions <folder>]"

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const { values } = parseArgs({
  options: {
    replay: { type: "string" },
    speed: { type: "string", default: "1" },
    // Session titles cost a Haiku request per user message, so replays only make them when asked.
    titles: { type: "boolean", default: false },
    sessions: { type: "string" },
  },
})
if (!values.replay) fail(USAGE)
const speed = parseSpeed(values.speed)
if (speed === null) fail(`Invalid speed "${values.speed}". ${USAGE}`)

const recording = await loadRecording(values.replay).catch((error: unknown) => {
  fail(error instanceof RecordingError ? `Cannot load replay: ${error.message}` : String(error))
})

function gitBranch(): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: process.cwd(), stderr: "ignore" })
  if (result.exitCode !== 0) return null
  return result.stdout.toString().trim() || null
}

const cwd = process.cwd()
const workspace = {
  cwd: cwd.startsWith(homedir()) ? `~${cwd.slice(homedir().length)}` : cwd,
  branch: gitBranch(),
  version: packageJson.version,
}
const firstModel = recordedModel(recording)
const sessionsFolder = values.sessions ?? projectFolder(CLAUDE_PROJECTS, cwd)
const sessionsCwd = values.sessions ? null : realpathSync(cwd)

const source = createReplaySource(recording, speed)
const provider = replayProvider(recording)
const session = createSession()
const { settings: stored, problem } = loadSettings()
initSettings(stored)
const renderer = await createCliRenderer({ exitOnCtrlC: false, consoleMode: "disabled", openConsoleOnError: false })

// The renderer's own handlers console.error to the terminal, so ours replace them.
process.removeAllListeners("uncaughtException")
process.removeAllListeners("unhandledRejection")
process.on("uncaughtException", (error) => log.error("uncaught exception", error))
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", reason))

const look = await readTerminal(renderer)
// A terminal that answers palette queries supports truecolor in practice, so that stands in until capabilities arrive.
const rgb = renderer.capabilities?.rgb ?? look.tints !== null
log.info("terminal", { tints: look.tints !== null, dark: look.dark, rgb })
setTerminal({ ...look, rgb })
setTheme(settings.theme)

let quitting = false

async function quit(): Promise<void> {
  if (quitting) return
  quitting = true
  source.close()
  try {
    await destroyTreeSitterClient()
  } finally {
    renderer.destroy()
    process.exit(0)
  }
}

const INVALID_LOG_EVERY = 100
const invalidCounts = new Map<string, number>()

async function pump(): Promise<void> {
  try {
    for await (const event of source.events) {
      const parsed = parse(event.line)
      if (parsed.kind === "invalid") {
        const count = (invalidCounts.get(parsed.key) ?? 0) + 1
        invalidCounts.set(parsed.key, count)
        if (count === 1) log.warn(`invalid ${parsed.key} message: ${parsed.error}`, parsed.raw)
        else if (count % INVALID_LOG_EVERY === 0) log.warn(`invalid ${parsed.key} messages: ${count} so far`)
      }
      if (parsed.kind === "unknown") log.debug(`unknown message ${parsed.key}`)
      session.apply(event.dir, parsed, event.at)
    }
  } catch (error) {
    log.error("replay failed", error)
  }
  session.end()
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

void pump()
await render(
  () => (
    <Show
      when={view()}
      keyed
      fallback={
        <App
          session={session.state}
          model={() => session.state.info?.model ?? firstModel}
          workspace={workspace}
          replay={{
            file: basename(values.replay ?? ""),
            speed: speed === "instant" ? "instant" : `${speed}x`,
            status: source.status,
          }}
          titles={values.titles}
          settingsProblem={problem}
          provider={provider}
          sessions={sessions}
          onSubmit={(text) => source.send(userMessage(text))}
          onAnswer={(ask, response) => {
            log.info(`answer to ${ask.toolName}`, response)
            session.answer(response)
            source.send(response)
          }}
          onQuit={() => void quit()}
        />
      }
    >
      {(shown) => (
        <App
          session={shown.session.state}
          model={() => shown.entry.model ?? firstModel}
          workspace={workspace}
          replay={null}
          readOnly={{ title: shown.entry.title, summary: shown.entry.firstPrompt }}
          titles={false}
          settingsProblem={null}
          provider={provider}
          sessions={sessions}
          earlier={shown.earlier() !== null}
          onEarlier={() => {
            loadEarlier(shown).catch((error: unknown) => log.error("cannot load earlier conversation", error))
          }}
          onSubmit={() => {}}
          onAnswer={() => {}}
          onQuit={() => void quit()}
        />
      )}
    </Show>
  ),
  renderer,
)
