import { createCliRenderer, destroyTreeSitterClient } from "@opentui/core"
import { render } from "@opentui/solid"
import { homedir } from "node:os"
import { basename } from "node:path"
import { parseArgs } from "node:util"
import { log } from "./log/log.ts"
import { parse } from "./protocol/parse.ts"
import { userMessage } from "./protocol/outgoing.ts"
import { createSession } from "./session/session.ts"
import packageJson from "../package.json"
import { loadRecording, RecordingError, recordedModel } from "./source/recording.ts"
import { createReplaySource, parseSpeed } from "./source/replay.ts"
import { readTerminal } from "./theme/palette.ts"
import { setTerminal } from "./theme/theme.ts"
import { App } from "./ui/app.tsx"

const USAGE = "Usage: bun run dev --replay <file.jsonl> [--speed <number|instant>] [--titles]"

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

const source = createReplaySource(recording, speed)
const session = createSession()
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

void pump()
await render(
  () => (
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
      onSubmit={(text) => source.send(userMessage(text))}
      onAnswer={(ask, response) => {
        log.info(`answer to ${ask.toolName}`, response)
        session.answer(response)
        source.send(response)
      }}
      onQuit={() => void quit()}
    />
  ),
  renderer,
)
