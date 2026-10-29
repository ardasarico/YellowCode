import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detect } from "./detect.ts"

const root = await mkdtemp(join(tmpdir(), "yc-cx-detect-"))
afterAll(() => rm(root, { recursive: true, force: true }))

let n = 0
// A folder with a fake `codex` that prints `output` and exits with `code`. With `app-server` it leaves a mark, so a
// test can tell detection never started one.
async function fake(output: string, code = 0): Promise<string> {
  const dir = join(root, String(n++))
  await mkdir(dir, { recursive: true })
  const script = `#!/bin/sh\n[ "$1" = app-server ] && touch '${dir}/started'\nprintf '%s\\n' '${output}'\nexit ${code}\n`
  await writeFile(join(dir, "codex"), script)
  await chmod(join(dir, "codex"), 0o755)
  return dir
}

test.each([
  ["codex-cli 0.165.0", "0.165.0"],
  ["codex 0.165.0", "0.165.0"],
  ["0.165.0", "0.165.0"],
  ["codex-cli 0.200.1-alpha.3", "0.200.1-alpha.3"],
  ["codex-cli 0.1.0", "0.1.0"],
])("%s on PATH", async (output, version) => {
  const dir = await fake(output)
  expect(await detect(dir)).toEqual({ installed: true, version, blocked: null, signedIn: null })
  expect(await Bun.file(join(dir, "started")).exists()).toBe(false)
})

test("garbage, a failing binary or no binary is not installed", async () => {
  expect(await detect(await fake("command not found"))).toEqual({ installed: false })
  expect(await detect(await fake("codex-cli 0.165.0", 1))).toEqual({ installed: false })
  const empty = join(root, "empty")
  await mkdir(empty)
  expect(await detect(empty)).toEqual({ installed: false })
})
