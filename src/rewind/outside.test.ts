import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitEnv, runGit } from "./common.ts"
import { fileHash, keepBytes, restoreOutside } from "./outside.ts"

const temp = realpathSync(mkdtempSync(join(tmpdir(), "yellowcode-outside-")))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

async function newStore(): Promise<string> {
  const store = mkdtempSync(join(temp, "store-"))
  await runGit(["init", "--bare", "-q", join(store, "git")], { env: gitEnv({}) })
  return store
}

const bytes = (text: string) => new TextEncoder().encode(text)

test("restoreOutside puts back a changed file, removes a created one and brings back a deleted one", async () => {
  const store = await newStore()
  const dir = mkdtempSync(join(temp, "files-"))
  const changed = join(dir, "changed.txt")
  const created = join(dir, "created.txt")
  const deleted = join(dir, "deleted.txt")

  const original = (await keepBytes(store, bytes("original")))!
  const gone = (await keepBytes(store, bytes("was here")))!
  writeFileSync(changed, "edited")
  writeFileSync(created, "new")
  const edited = (await fileHash(store, changed))!
  const fresh = (await fileHash(store, created))!

  const files = [
    { path: changed, before: original, after: edited },
    { path: created, before: null, after: fresh },
    { path: deleted, before: gone, after: null, mode: 0o600 },
  ]

  const dry = await restoreOutside(store, files, { dryRun: true })
  expect([dry.restored.length, dry.deleted.length, dry.kept.length]).toEqual([2, 1, 0])
  expect(readFileSync(changed, "utf8")).toBe("edited")
  expect(existsSync(created)).toBe(true)

  const result = await restoreOutside(store, files, { keep: true })
  expect(result.restored.toSorted()).toEqual([changed, deleted].toSorted())
  expect(result.deleted).toEqual([created])
  expect(result.kept).toEqual([])
  expect(result.undo).toHaveLength(3)
  expect(readFileSync(changed, "utf8")).toBe("original")
  expect(existsSync(created)).toBe(false)
  expect(readFileSync(deleted, "utf8")).toBe("was here")
  expect(lstatSync(deleted).mode & 0o777).toBe(0o600)

  const undone = await restoreOutside(store, result.undo)
  expect(undone.kept).toEqual([])
  expect(readFileSync(changed, "utf8")).toBe("edited")
  expect(readFileSync(created, "utf8")).toBe("new")
  expect(existsSync(deleted)).toBe(false)
})

test("restoreOutside keeps a file that changed again since the rewind point", async () => {
  const store = await newStore()
  const dir = mkdtempSync(join(temp, "files-"))
  const file = join(dir, "a.txt")
  const original = (await keepBytes(store, bytes("original")))!
  writeFileSync(file, "edited")
  const edited = (await fileHash(store, file))!
  writeFileSync(file, "edited again")

  const result = await restoreOutside(store, [{ path: file, before: original, after: edited }])
  expect(result.kept).toEqual([file])
  expect(readFileSync(file, "utf8")).toBe("edited again")
})

test("restoreOutside leaves a file behind a symlinked folder alone", async () => {
  const store = await newStore()
  const real = mkdtempSync(join(temp, "real-"))
  mkdirSync(join(real, "sub"))
  const link = join(temp, "link")
  Bun.spawnSync(["ln", "-s", real, link])
  const file = join(link, "sub", "a.txt")
  writeFileSync(join(real, "sub", "a.txt"), "x")
  const result = await restoreOutside(store, [{ path: file, before: null, after: "0".repeat(40) }])
  expect(result.kept).toEqual([file])
  expect(existsSync(join(real, "sub", "a.txt"))).toBe(true)
})
