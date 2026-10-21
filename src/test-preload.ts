import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Code under test logs as the app does, so the log goes to a folder of its own instead of the user's log.
const dir = mkdtempSync(join(tmpdir(), "yellowcode-test-logs-"))
process.env["YELLOWCODE_LOG_DIR"] = dir
afterAll(() => rmSync(dir, { recursive: true, force: true }))
