import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detect } from "./detect.ts"

const root = await mkdtemp(join(tmpdir(), "yc-oc-detect-"))
afterAll(() => rm(root, { recursive: true, force: true }))

let n = 0
// A folder with a fake `opencode` that prints `output` and exits with `code`.
async function fake(output: string, code = 0, dir = join(root, String(n++))): Promise<string> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "opencode"), `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${code}\n`)
  await chmod(join(dir, "opencode"), 0o755)
  return dir
}

const empty = join(root, "empty")
await mkdir(empty)

test.each([
  ["opencode v2.2.0", "2.2.0", null],
  ["v2.2.0", "2.2.0", null],
  ["2.2.0", "2.2.0", null],
  ["3.0.0-beta.1", "3.0.0-beta.1", null],
  ["1.4.3", "1.4.3", "needs opencode 2"],
])("%s on PATH", async (output, version, blocked) => {
  expect(await detect(await fake(output), empty)).toEqual({ installed: true, version, blocked, signedIn: null })
})

test("garbage or a failing binary is not installed", async () => {
  expect(await detect(await fake("command not found"), empty)).toEqual({ installed: false })
  expect(await detect(await fake("2.2.0", 1), empty)).toEqual({ installed: false })
})

test("a missing binary is not installed", async () => {
  expect(await detect(empty, empty)).toEqual({ installed: false })
})

test("~/.opencode/bin is the fallback, and PATH comes first", async () => {
  const home = join(root, "home")
  await fake("2.1.0", 0, join(home, ".opencode", "bin"))
  expect(await detect(empty, home)).toMatchObject({ installed: true, version: "2.1.0" })
  expect(await detect(await fake("2.2.0"), home)).toMatchObject({ installed: true, version: "2.2.0" })
})
