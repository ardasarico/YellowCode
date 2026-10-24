import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { importBackups, readHistory } from "./import.ts"
import { readManifest } from "./live-rewind.ts"
import { restoreInput } from "./preview.ts"
import { applyRestore, planRestore } from "./restore.ts"
import { openSnapshots } from "./snapshots.ts"

// A stock session (P5 probe, scrubbed): p1 Write creates new.txt, p2 Edits README.md, p3 Write overwrites new.txt,
// p4 appends to README.md with Bash.
const fixture = readFileSync(join(import.meta.dir, "../../fixtures/rewind/claude-backups.jsonl"), "utf8")
const prompts = [
  "16626daf-1541-4497-99d6-ba25a0591c3a",
  "4c3b8f16-c6e4-41df-bc2a-e5cdacf5c66a",
  "b8a97756-68d0-4452-8d0e-6642412495f9",
  "3994e2f5-ec69-4c0d-bf49-2ad91435369d",
]

const temp = realpathSync(mkdtempSync(join(tmpdir(), "yellowcode-import-")))
const saved = { HOME: process.env["HOME"], YELLOWCODE_SNAPSHOT_DIR: process.env["YELLOWCODE_SNAPSHOT_DIR"] }
mkdirSync(join(temp, "home"))
process.env["HOME"] = join(temp, "home")
process.env["YELLOWCODE_SNAPSHOT_DIR"] = join(temp, "store")
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(temp, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

// Backup names start with the sha256 of the file's path, so the fixture's names follow the folder it is put in.
const hashOf = (file: string) => new Bun.CryptoHasher("sha256").update(file).digest("hex").slice(0, 16)
const localize = (text: string, dir: string) =>
  text
    .replaceAll("91c8962bec4aaca1", hashOf(`${dir}/README.md`))
    .replaceAll("be044052e7b147c6", hashOf(`${dir}/new.txt`))
    .replaceAll("/project", dir)

test("the transcript maps each prompt to the backups of the files its Edit/Write calls changed", () => {
  const history = readHistory(localize(fixture, "/p"))
  expect(history?.map((prompt) => prompt.uuid)).toEqual(prompts)
  expect(history?.map((prompt) => Object.fromEntries(prompt.writes))).toEqual([
    { "/p/new.txt": "create" },
    { "/p/README.md": "update" },
    { "/p/new.txt": "update" },
    {},
  ])
  expect(history?.[0]?.backups.get("/p/new.txt")).toBeNull()
  expect(history?.[1]?.backups.get("/p/README.md")).toBe(`${hashOf("/p/README.md")}@v1`)
  expect(history?.[2]?.backups.get("/p/new.txt")).toBe(`${hashOf("/p/new.txt")}@v2`)
  expect(history?.[1]?.left.get("/p/README.md")).toContain("line fourteen edited\n")
  expect(history?.[2]?.left.get("/p/new.txt")).toBe("new v2 overwritten\n")
  expect(readHistory('{"type":"file-history-snapshot","snapshot":{}}')).toBeNull()
})

test("a backup belongs to the folder claude recorded, not the cwd a Bash cd left", () => {
  const moved = localize(fixture, "/p").replaceAll('"cwd":"/p"', '"cwd":"/p/sub"')
  expect(readHistory(moved)?.[1]?.backups.get("/p/README.md")).toBe(`${hashOf("/p/README.md")}@v1`)
  // A name whose hash does not match the path is dropped.
  const wrong = localize(fixture, "/p").replaceAll('"realParentDir":"/p"', '"realParentDir":"/p/sub"')
  expect([...(readHistory(wrong)?.[1]?.backups.keys() ?? [])]).toEqual([])
})

test("imported prompts rewind their Edit/Write files and leave Bash changes alone", async () => {
  const dir = join(temp, "project")
  mkdirSync(dir)
  writeFileSync(join(dir, "README.md"), "original\n")
  git(dir, "init", "-q", "-b", "main")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "first")
  writeFileSync(join(dir, "README.md"), "edited\nbashline\n")
  writeFileSync(join(dir, "new.txt"), "new v2\n")
  const backups = join(temp, "file-history")
  mkdirSync(backups)
  writeFileSync(join(backups, `${hashOf(`${dir}/README.md`)}@v1`), "original\n")
  writeFileSync(join(backups, `${hashOf(`${dir}/README.md`)}@v2`), "edited\n")
  writeFileSync(join(backups, `${hashOf(`${dir}/new.txt`)}@v2`), "new v1\n")
  const transcript = join(temp, "session.jsonl")
  writeFileSync(transcript, localize(fixture, dir))

  const snapshots = await openSnapshots(dir)
  if (!snapshots) throw new Error("snapshots off")
  await importBackups(snapshots, transcript, "session", backups)
  const manifests = prompts.map((uuid) => readManifest(snapshots.store, uuid))
  expect(manifests.map((manifest) => manifest?.segments[0]?.kind)).toEqual([
    "imported",
    "imported",
    "imported",
    "imported",
  ])

  const rewind = async (prompt: number) => {
    const input = await restoreInput(snapshots, manifests, prompt)
    if (!input) throw new Error("no input")
    const safety = await snapshots.take(`safety-${prompt}`)
    if (!safety) throw new Error("no safety")
    return applyRestore(await planRestore({ ...input, safety, after: input.after ?? safety }))
  }
  expect(await rewind(3)).toEqual({ restored: [], deleted: [], kept: [] })
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("edited\nbashline\n")
  expect(await rewind(1)).toEqual({ restored: ["README.md", "new.txt"], deleted: [], kept: [] })
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("original\n")
  expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("new v1\n")
  // p1's Write created new.txt, so p3's update does not keep it.
  expect(await rewind(0)).toEqual({ restored: ["README.md"], deleted: ["new.txt"], kept: [] })
  expect(existsSync(join(dir, "new.txt"))).toBe(false)
  // A later prompt without a manifest leaves the files alone instead of skipping it.
  expect(await restoreInput(snapshots, [...manifests.slice(0, 2), null], 0)).toBeNull()
})
