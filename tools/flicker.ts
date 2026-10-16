// Replays a fixture in tmux, captures the screen at 30 fps and counts flip-backs:
// a screen line that returns to the exact content (with styles) it had two frames earlier.
// The window is tall by default because scrolling makes repeated lines look like flip-backs.
/* oxlint-disable no-await-in-loop */
import { parseArgs } from "node:util"

const FRAME_MS = 33
const SETTLE_MS = 3_000
const TIMEOUT_MS = 120_000

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    width: { type: "string", default: "100" },
    height: { type: "string", default: "500" },
    speed: { type: "string", default: "4" },
    verbose: { type: "boolean", default: false },
    dump: { type: "string" },
  },
})
const fixture = positionals[0]
if (!fixture) {
  process.stderr.write("Usage: bun run flicker <fixture.jsonl> [--width 100] [--height 500] [--speed 4]\n")
  process.exit(1)
}

const session = `yellowcode-flicker-${process.pid}`

function tmux(...args: string[]): string {
  const result = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" })
  return result.stdout.toString()
}

const capture = (): string[] => tmux("capture-pane", "-p", "-e", "-t", session).split("\n")

tmux("kill-session", "-t", session)
tmux(
  "new-session",
  "-d",
  "-s",
  session,
  "-x",
  values.width,
  "-y",
  values.height,
  "-c",
  process.cwd(),
  `bun src/index.tsx --replay ${fixture} --speed ${values.speed} --sessions fixtures/transcripts/-Users-user-project --skip-terminal-check; sleep 600`,
)

try {
  const started = Date.now()
  while (!capture().some((line) => line.includes("Enter sends the next recorded message"))) {
    if (Date.now() - started > 10_000) throw new Error("the app did not start")
    await Bun.sleep(100)
  }
  // The welcome screen animates, so the first message goes out before any frame is compared.
  tmux("send-keys", "-t", session, "Enter")

  const frames: string[][] = []
  let flipBacks = 0
  const flippedLines = new Map<number, number>()
  let lastChange = Date.now()
  let sends = 1

  while (Date.now() - started < TIMEOUT_MS) {
    const frame = capture()
    const previous = frames.at(-1)
    const beforePrevious = frames.at(-2)
    if (previous && frame.join("\n") !== previous.join("\n")) lastChange = Date.now()
    if (previous && beforePrevious) {
      frame.forEach((line, row) => {
        if (line !== previous[row] && line === beforePrevious[row]) {
          flipBacks += 1
          flippedLines.set(row, (flippedLines.get(row) ?? 0) + 1)
          if (values.verbose)
            console.log(JSON.stringify({ frame: frames.length, row, a: beforePrevious[row], b: previous[row] }))
        }
      })
    }
    frames.push(frame)
    if (values.dump) await Bun.write(`${values.dump}/${String(frames.length).padStart(4, "0")}.txt`, frame.join("\n"))

    const waiting = frame.some((line) => line.includes("Enter: next message"))
    const finished = frame.some((line) => line.includes("finished"))
    if (waiting && Date.now() - lastChange > 300) {
      tmux("send-keys", "-t", session, "Enter")
      sends += 1
      lastChange = Date.now()
    }
    if (finished && Date.now() - lastChange > SETTLE_MS) break
    await Bun.sleep(FRAME_MS)
  }

  console.log(`${fixture}: ${frames.length} frames, ${sends} messages sent, ${flipBacks} flip-backs`)
  for (const [row, count] of [...flippedLines].toSorted((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  row ${row}: ${count}`)
  }
  process.exitCode = flipBacks === 0 ? 0 : 1
} finally {
  tmux("kill-session", "-t", session)
}
