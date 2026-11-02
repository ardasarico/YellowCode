import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detect } from "./detect.ts"

const root = await mkdtemp(join(tmpdir(), "yc-pi-detect-"))
afterAll(() => rm(root, { recursive: true, force: true }))

let n = 0
// A folder with a fake `pi` that prints `output` and exits with `code`.
async function fake(output: string, code = 0): Promise<string> {
  const dir = join(root, String(n++))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "pi"), `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${code}\n`)
  await chmod(join(dir, "pi"), 0o755)
  return dir
}

test.each([
  ["1.4.0", "1.4.0"],
  ["pi 1.4.0", "1.4.0"],
  ["v2.0.1-beta.2", "2.0.1-beta.2"],
])("%s on PATH", async (output, version) => {
  expect(await detect(await fake(output))).toEqual({ installed: true, version, blocked: null, signedIn: null })
})

test("garbage, a failing binary or no binary is not installed", async () => {
  expect(await detect(await fake("command not found"))).toEqual({ installed: false })
  expect(await detect(await fake("1.4.0", 1))).toEqual({ installed: false })
  const empty = join(root, "empty")
  await mkdir(empty)
  expect(await detect(empty)).toEqual({ installed: false })
})
