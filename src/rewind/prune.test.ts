import { afterAll, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { refsUnder } from "./outside.ts"
import { pruneStore } from "./prune.ts"
import { openSnapshots, type Snapshots } from "./snapshots.ts"

const temp = mkdtempSync(join(tmpdir(), "yellowcode-prune-"))
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

function git(cwd: string, ...args: string[]): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((path) => {
      const stat = lstatSync(join(dir, path))
      return `${path} ${stat.size} ${stat.mtimeMs}`
    })
    .toSorted()
}

function manifest(snapshots: Snapshots, uuid: string, sentAt: number, id: string, tree: string): void {
  const point = { id, tree, unknown: [] }
  const segment = { kind: "turn", before: point, beforeAt: sentAt, after: null, changes: [], writes: [] }
  mkdirSync(join(snapshots.store, "prompts"), { recursive: true })
  const body = { uuid, sessionId: null, sentAt, segments: [segment], latest: {}, shells: [] }
  writeFileSync(join(snapshots.store, "prompts", `${uuid}.json`), JSON.stringify(body))
}

test("old manifests and their refs go, recent snapshots still read", async () => {
  const dir = join(temp, "project")
  mkdirSync(dir)
  writeFileSync(join(dir, "kept.txt"), "committed\n")
  git(dir, "init", "-q", "-b", "main")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "first")
  const snapshots = await openSnapshots(dir)
  if (!snapshots) throw new Error("snapshots off")

  writeFileSync(join(dir, "new.txt"), "old\n")
  const old = await snapshots.take("old")
  writeFileSync(join(dir, "new.txt"), "recent\n")
  writeFileSync(join(dir, "shared.txt"), "shared\n")
  const recent = await snapshots.take("recent")
  // The project now holds, packed, a blob the store has its own copy of.
  git(dir, "add", "shared.txt")
  git(dir, "commit", "-qm", "shared")
  git(dir, "gc", "-q")
  writeFileSync(join(dir, "new.txt"), "stray\n")
  await snapshots.take("stray")
  if (!old || !recent) throw new Error("snapshot not taken")

  const projectGit = listing(join(dir, ".git"))
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  manifest(snapshots, "old-prompt", now - 40 * day, "old", old.tree)
  manifest(snapshots, "recent-prompt", now - day, "recent", recent.tree)
  const twoDaysAgo = new Date(now - 2 * day)
  utimesSync(join(snapshots.store, "git", "refs", "yc", "stray"), twoDaysAgo, twoDaysAgo)

  expect(await pruneStore(snapshots, 30, now)).toEqual({ manifests: 1, refs: 2, gc: "done" })
  expect(existsSync(join(snapshots.store, "prompts", "old-prompt.json"))).toBe(false)
  expect(await refsUnder(snapshots.store, "refs/yc/")).toEqual(["refs/yc/recent"])

  expect(listing(join(dir, ".git"))).toEqual(projectGit)

  const entries = await snapshots.entries(recent.tree, ["new.txt", "kept.txt", "shared.txt"])
  const blobs = await snapshots.blobs([...entries.values()].map((entry) => entry.sha))
  expect([...blobs.values()].map((bytes) => new TextDecoder().decode(bytes)).toSorted()).toEqual([
    "committed\n",
    "recent\n",
    "shared\n",
  ])
  // Read without the project's objects: the store's own copy.
  const shared = entries.get("shared.txt")?.sha ?? ""
  const own = Bun.spawnSync(["git", "cat-file", "-e", shared], {
    env: { PATH: process.env["PATH"] ?? "", GIT_DIR: join(snapshots.store, "git") },
  })
  expect(own.exitCode).toBe(0)
  expect(await pruneStore(snapshots, 30, now)).toBeNull()
})
