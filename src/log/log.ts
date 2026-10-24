import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const dir = process.env["YELLOWCODE_LOG_DIR"] ?? join(homedir(), ".yellowcode", "logs")
const file = join(dir, "yellowcode.log")
const debugEnabled = process.env["YELLOWCODE_DEBUG"] === "1"
const MAX_BYTES = 5 * 1024 * 1024
let ready = false
let size = 0

// The file's size, 0 once it is moved aside past MAX_BYTES.
function rotate(): number {
  try {
    const now = statSync(file).size
    if (now <= MAX_BYTES) return now
    renameSync(file, `${file}.1`)
  } catch {
    // No log file yet.
  }
  return 0
}

function write(level: string, message: string, detail?: unknown): void {
  try {
    const suffix = detail === undefined ? "" : ` ${typeof detail === "string" ? detail : Bun.inspect(detail)}`
    if (!ready || size > MAX_BYTES) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      size = rotate()
      ready = true
    }
    const line = `${new Date().toISOString()} ${level} ${message}${suffix}\n`
    appendFileSync(file, line, { mode: 0o600 })
    size += Buffer.byteLength(line)
  } catch {
    // The TUI owns the terminal, so a failed write is dropped rather than printed or thrown.
    ready = false
  }
}

export const log = {
  debug: (message: string, detail?: unknown) => {
    if (debugEnabled) write("debug", message, detail)
  },
  info: (message: string, detail?: unknown) => write("info", message, detail),
  warn: (message: string, detail?: unknown) => write("warn", message, detail),
  error: (message: string, detail?: unknown) => write("error", message, detail),
}
