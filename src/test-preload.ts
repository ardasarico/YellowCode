import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Temp files and the log of code under test go to one folder that is removed after the run.
const dir = mkdtempSync(join(tmpdir(), "yellowcode-test-"))
process.env["TMPDIR"] = dir
process.env["YELLOWCODE_LOG_DIR"] = join(dir, "logs")
afterAll(() => rmSync(dir, { recursive: true, force: true }))
