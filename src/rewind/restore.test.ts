import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyRestore, createdIn, planRestore, type RestorePlan, type RestoreResult, type Write } from "./restore.ts"
import { type Change, openSnapshots, type Snapshots, type Taken } from "./snapshots.ts"

const temp = mkdtempSync(join(tmpdir(), "yellowcode-restore-"))
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

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

async function project(files: Record<string, string>): Promise<{ dir: string; snapshots: Snapshots }> {
  const dir = mkdtempSync(join(temp, "project-"))
  // Old mtimes keep the copied index clean, so committed blobs stay borrowed from the project.
  const old = new Date(Date.now() - 60_000)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
    utimesSync(join(dir, path), old, old)
  }
  git(dir, "init", "-q", "-b", "main")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "first")
  const snapshots = await openSnapshots(dir)
  if (!snapshots) throw new Error("snapshots off")
  return { dir, snapshots }
}

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((path) => {
      const stat = lstatSync(join(dir, path))
      return `${path} ${stat.size} ${stat.mtimeMs}`
    })
    .toSorted()
}

let ids = 0
async function take(snapshots: Snapshots): Promise<Taken> {
  const taken = await snapshots.take(`t${ids++}`)
  if (!taken) throw new Error("snapshot not taken")
  return taken
}

type Turn = { at: number; before: Taken; after: Taken; changes: Change[] }

async function turn(snapshots: Snapshots, change: () => void): Promise<Turn> {
  const at = Date.now()
  const before = await take(snapshots)
  change()
  const after = await take(snapshots)
  return { at, before, after, changes: await snapshots.changes(before.tree, after.tree) }
}

type Options = { writes?: Write[]; unknown?: string[]; targetAt?: number }

// Rewinds to the first of the turns, as a rewind on its prompt would.
async function rewind(snapshots: Snapshots, turns: Turn[], options: Options = {}): Promise<RestoreResult> {
  return applyRestore(await planFor(snapshots, turns, options))
}

async function planFor(snapshots: Snapshots, turns: Turn[], options: Options = {}): Promise<RestorePlan> {
  const first = turns[0]
  const last = turns.at(-1)
  if (!first || !last) throw new Error("no turns")
  const safety = await take(snapshots)
  const plan: RestorePlan = await planRestore({
    snapshots,
    target: first.before,
    targetAt: options.targetAt ?? first.at,
    safety: { ...safety, unknown: options.unknown ?? safety.unknown },
    after: last.after,
    paths: turns.flatMap((one) => one.changes.map((change) => change.path)),
    created: createdIn(turns.map((one) => one.changes)),
    writes: options.writes ?? [],
  })
  return plan
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8")

test("only the undone turns' paths come back, and the project's .git is untouched", async () => {
  const { dir, snapshots } = await project({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" })
  const gitDir = listing(join(dir, ".git"))
  const first = await turn(snapshots, () => writeFileSync(join(dir, "a.txt"), "claude\n"))
  writeFileSync(join(dir, "b.txt"), "mine\n")
  const userEdit = lstatSync(join(dir, "b.txt")).mtimeMs
  const second = await turn(snapshots, () => {
    writeFileSync(join(dir, "n.txt"), "new\n")
    rmSync(join(dir, "c.txt"))
  })

  expect(await rewind(snapshots, [first, second])).toEqual({
    restored: ["a.txt", "c.txt"],
    deleted: ["n.txt"],
    kept: [],
  })
  expect([read(dir, "a.txt"), read(dir, "b.txt"), read(dir, "c.txt")]).toEqual(["a\n", "mine\n", "c\n"])
  expect(existsSync(join(dir, "n.txt"))).toBe(false)
  expect(lstatSync(join(dir, "b.txt")).mtimeMs).toBe(userEdit)
  expect(listing(join(dir, ".git"))).toEqual(gitDir)
})

test("an ignored file the turn made visible is kept", async () => {
  const { dir, snapshots } = await project({ ".gitignore": "secret.txt\n" })
  writeFileSync(join(dir, "secret.txt"), "key\n")
  const undone = await turn(snapshots, () => {
    writeFileSync(join(dir, ".gitignore"), "")
    writeFileSync(join(dir, "secret.txt"), "other key\n")
  })

  expect(await rewind(snapshots, [undone])).toEqual({
    restored: [".gitignore"],
    deleted: [],
    kept: [{ path: "secret.txt", reason: "could not tell it is new" }],
  })
  expect(read(dir, "secret.txt")).toBe("other key\n")
})

test("a file Write reported as an update is not deleted, though no snapshot held it", async () => {
  const { dir, snapshots } = await project({ "a.txt": "a\n" })
  const undone = await turn(snapshots, () => writeFileSync(join(dir, "w.txt"), "written\n"))

  const result = await rewind(snapshots, [undone], { writes: [{ path: "w.txt", kind: "update" }] })

  expect(result.kept).toEqual([{ path: "w.txt", reason: "could not tell it is new" }])
  expect(read(dir, "w.txt")).toBe("written\n")
})

test("a file Write created and Edit then changed is deleted", async () => {
  const { dir, snapshots } = await project({ "a.txt": "a\n" })
  const undone = await turn(snapshots, () => writeFileSync(join(dir, "w.txt"), "written\nedited\n"))
  const writes: Write[] = [
    { path: "w.txt", kind: "create" },
    { path: "w.txt", kind: "update" },
  ]

  expect(await rewind(snapshots, [undone], { writes })).toEqual({ restored: [], deleted: ["w.txt"], kept: [] })
  expect(existsSync(join(dir, "w.txt"))).toBe(false)
})

test("a moved file goes back to its old name, and a moved file edited after the move stays", async () => {
  const { dir, snapshots } = await project({ "a.txt": "a\n", "c.txt": "c\n" })
  const undone = await turn(snapshots, () => {
    renameSync(join(dir, "a.txt"), join(dir, "b.txt"))
    renameSync(join(dir, "c.txt"), join(dir, "d.txt"))
    writeFileSync(join(dir, "d.txt"), "edited\n")
  })

  expect(await rewind(snapshots, [undone])).toEqual({
    restored: ["a.txt", "c.txt"],
    deleted: ["b.txt"],
    kept: [{ path: "d.txt", reason: "could not tell it is new" }],
  })
  expect([read(dir, "a.txt"), read(dir, "c.txt"), read(dir, "d.txt")]).toEqual(["a\n", "c\n", "edited\n"])
})

test("an ignored file moved to a name git sees is kept", async () => {
  const { dir, snapshots } = await project({ ".gitignore": ".env\n" })
  writeFileSync(join(dir, ".env"), "KEY=1\n")
  const undone = await turn(snapshots, () => renameSync(join(dir, ".env"), join(dir, ".env.bak")))

  expect((await rewind(snapshots, [undone])).kept).toEqual([{ path: ".env.bak", reason: "could not tell it is new" }])
  expect(read(dir, ".env.bak")).toBe("KEY=1\n")
})

test("a .gitignore the turn created is gone before git is asked what is ignored", async () => {
  const { dir, snapshots } = await project({ ".gitignore": "secret.txt\n", "sub/keep.txt": "k\n" })
  writeFileSync(join(dir, "sub/secret.txt"), "key\n")
  const undone = await turn(snapshots, () => writeFileSync(join(dir, "sub/.gitignore"), "!secret.txt\n"))

  // As on a disk without birth times, so only the ignore rules keep the secret.
  expect(await rewind(snapshots, [undone], { targetAt: 0 })).toEqual({
    restored: [],
    deleted: ["sub/.gitignore"],
    kept: [{ path: "sub/secret.txt", reason: "could not tell it is new" }],
  })
})

test("nothing is deleted inside a folder the target holds as a nested repository", async () => {
  const { dir, snapshots } = await project({ "a.txt": "a\n" })
  mkdirSync(join(dir, "sub"))
  writeFileSync(join(dir, "sub/x.txt"), "work\n")
  git(join(dir, "sub"), "init", "-q")
  git(join(dir, "sub"), "add", "-A")
  git(join(dir, "sub"), "commit", "-qm", "sub")
  const undone = await turn(snapshots, () => rmSync(join(dir, "sub/.git"), { recursive: true }))

  expect((await rewind(snapshots, [undone])).kept).toEqual([
    { path: "sub", reason: "not a regular file" },
    { path: "sub/x.txt", reason: "inside another repository" },
  ])
})

test("a file that grew past 2 MB in the turn is kept", async () => {
  const { dir, snapshots } = await project({ "a.txt": "a\n" })
  writeFileSync(join(dir, "big.log"), "small\n")
  const undone = await turn(snapshots, () => writeFileSync(join(dir, "big.log"), new Uint8Array(3 * 1024 * 1024)))

  expect((await rewind(snapshots, [undone])).kept).toEqual([{ path: "big.log", reason: "changed just now" }])
  expect(lstatSync(join(dir, "big.log")).size).toBe(3 * 1024 * 1024)
})

test("a file the user changed after Claude is restored too", async () => {
  const { dir, snapshots } = await project({ "a.txt": "a\n" })
  const undone = await turn(snapshots, () => writeFileSync(join(dir, "a.txt"), "claude\n"))
  writeFileSync(join(dir, "a.txt"), "mine\n")

  expect((await rewind(snapshots, [undone])).restored).toEqual(["a.txt"])
  expect(read(dir, "a.txt")).toBe("a\n")
})

test("a file whose old bytes the project dropped is kept", async () => {
  const { dir, snapshots } = await project({ "a.txt": "a\n" })
  const undone = await turn(snapshots, () => writeFileSync(join(dir, "a.txt"), "claude\n"))
  git(dir, "checkout", "-q", "--orphan", "rewritten")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "rewritten")
  git(dir, "branch", "-q", "-D", "main")
  git(dir, "reflog", "expire", "--expire=now", "--all")
  git(dir, "gc", "-q", "--prune=now")

  expect((await rewind(snapshots, [undone])).kept).toEqual([{ path: "a.txt", reason: "snapshot incomplete" }])
  expect(read(dir, "a.txt")).toBe("claude\n")
})

test("a folder swapped for a symlink leaves the folder it points to as it was", async () => {
  const outside = mkdtempSync(join(temp, "outside-"))
  writeFileSync(join(outside, "x.txt"), "outside\n")
  const before = listing(outside)
  const { dir, snapshots } = await project({ "lib/x.txt": "inside\n" })
  const undone = await turn(snapshots, () => {
    rmSync(join(dir, "lib"), { recursive: true })
    symlinkSync(outside, join(dir, "lib"))
  })

  expect((await rewind(snapshots, [undone])).kept).toEqual([
    { path: "lib", reason: "not a regular file" },
    { path: "lib/x.txt", reason: "symlink in the path" },
  ])
  expect(listing(outside)).toEqual(before)
  expect(read(outside, "x.txt")).toBe("outside\n")
})

test("a file under a folder a snapshot could not read is kept", async () => {
  const { dir, snapshots } = await project({ "a.txt": "a\n" })
  const undone = await turn(snapshots, () => {
    mkdirSync(join(dir, "lib"))
    writeFileSync(join(dir, "lib/new.txt"), "new\n")
  })

  const result = await rewind(snapshots, [undone], { unknown: ["lib/"] })

  expect(result.kept).toEqual([{ path: "lib/new.txt", reason: "could not read it" }])
  expect(read(dir, "lib/new.txt")).toBe("new\n")
})

test("a dry run finds what the restore then does, and changes nothing", async () => {
  const { dir, snapshots } = await project({ "a.txt": "a\n", "c.txt": "c\n", "lib/x.txt": "x\n" })
  const undone = await turn(snapshots, () => {
    writeFileSync(join(dir, "a.txt"), "claude\n")
    writeFileSync(join(dir, "n.txt"), "new\n")
    rmSync(join(dir, "c.txt"))
    rmSync(join(dir, "lib"), { recursive: true })
    writeFileSync(join(dir, "lib"), "a file where the folder was\n")
    symlinkSync("a.txt", join(dir, "link"))
  })
  const plan = await planFor(snapshots, [undone])
  const files = listing(dir)

  const dry = await applyRestore(plan, { dryRun: true })

  expect(listing(dir)).toEqual(files)
  expect(dry.restored).toEqual(["a.txt", "c.txt", "lib/x.txt"])
  expect(await applyRestore(plan)).toEqual(dry)
})
