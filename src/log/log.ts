import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const dir = process.env["YELLOWCODE_LOG_DIR"] ?? join(homedir(), ".yellowcode", "logs")
const file = join(dir, "yellowcode.log")
const debugEnabled = process.env["YELLOWCODE_DEBUG"] === "1"
let ready = false

function write(level: string, message: string, detail?: unknown): void {
  try {
    const suffix = detail === undefined ? "" : ` ${typeof detail === "string" ? detail : Bun.inspect(detail)}`
    if (!ready) {
      mkdirSync(dir, { recursive: true })
      ready = true
    }
    appendFileSync(file, `${new Date().toISOString()} ${level} ${message}${suffix}\n`)
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
