import { afterAll, expect, test } from "bun:test"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSnapshots, type Snapshots } from "./snapshots.ts"

const temp = mkdtempSync(join(tmpdir(), "yellowcode-snapshots-"))
const saved = { HOME: process.env["HOME"], YELLOWCODE_SNAPSHOT_DIR: process.env["YELLOWCODE_SNAPSHOT_DIR"] }
const home = join(temp, "home")
mkdirSync(home)
process.env["HOME"] = home
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
  const result = Bun.spawnSync(
    // Background maintenance after a commit would add and remove lock files while a test lists .git.
    [
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "maintenance.auto=false",
      ...args,
    ],
    { cwd, env },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function folder(files: Record<string, string>, repo: boolean): string {
  const dir = mkdtempSync(join(temp, "project-"))
  // Old mtimes keep the project's index clean, so the copied index is used as is, cache-tree included.
  const old = new Date(Date.now() - 60_000)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
    utimesSync(join(dir, path), old, old)
  }
  if (repo) {
    git(dir, "init", "-q")
    git(dir, "add", "-A")
    git(dir, "commit", "-qm", "first")
  }
  return dir
}

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((path) => {
      const stat = lstatSync(join(dir, path))
      return `${path} ${stat.size} ${stat.mtimeMs}`
    })
    .toSorted()
}

async function taken(snapshots: Snapshots, id: string): Promise<string> {
  const snapshot = await snapshots.take(id)
  if (!snapshot) throw new Error("snapshot not taken")
  return snapshot.tree
}

async function opened(cwd: string): Promise<Snapshots> {
  const snapshots = await openSnapshots(cwd)
  if (!snapshots) throw new Error("snapshots off")
  return snapshots
}

test("open and take leave the project's .git, submodules included, as it was", async () => {
  const sub = folder({ "s.txt": "s\n" }, true)
  const dir = folder({ "a.txt": "a\n", "b.txt": "b\n", "src/c.txt": "c\n" }, true)
  git(dir, "submodule", "add", "-q", sub, "mod")
  git(dir, "commit", "-qm", "submodule")
  const committed = git(dir, "rev-parse", "HEAD:b.txt")
  let before = listing(join(dir, ".git"))
  // Same bytes with a new mtime: git hashes the file again and would refresh the project's copy of that blob.
  utimesSync(join(dir, "b.txt"), new Date(), new Date(Date.now() + 5000))
  writeFileSync(join(dir, "a.txt"), "changed\n")

  const snapshots = await opened(dir)
  const first = await taken(snapshots, "first")
  expect(listing(join(dir, ".git"))).toEqual(before)

  git(join(dir, "mod"), "commit", "-q", "--allow-empty", "-m", "moved")
  writeFileSync(join(dir, "src/c.txt"), "c\nmore\n")
  before = listing(join(dir, ".git"))
  const second = await taken(snapshots, "second")

  expect(listing(join(dir, ".git"))).toEqual(before)
  expect(await snapshots.changes(first, second)).toEqual([
    { path: "mod", status: "M", plus: 1, minus: 1 },
    { path: "src/c.txt", status: "M", plus: 1, minus: 0 },
  ])
  expect(await snapshots.missing([committed])).toEqual(new Set())
})

test("no filter, hook or line ending conversion runs", async () => {
  const dir = folder({ ".gitattributes": "* filter=mark\n", "a.txt": "a\n" }, true)
  const marks = mkdtempSync(join(temp, "marks-"))
  const hooks = join(home, "hooks")
  mkdirSync(hooks, { recursive: true })
  for (const name of ["post-index-change", "reference-transaction"]) {
    writeFileSync(join(hooks, name), `#!/bin/sh\ntouch '${marks}/${name}'\n`)
    chmodSync(join(hooks, name), 0o755)
  }
  writeFileSync(
    join(home, ".gitconfig"),
    `[core]\n\tautocrlf = true\n\thooksPath = ${hooks}\n` +
      `[filter "mark"]\n\tclean = touch '${marks}/filter' && cat\n\trequired = true\n`,
  )
  try {
    writeFileSync(join(dir, "crlf.txt"), "one\r\ntwo\r\n")
    const snapshots = await opened(dir)
    const tree = await taken(snapshots, "filters")
    const entry = (await snapshots.entries(tree, ["crlf.txt"])).get("crlf.txt")

    expect(new TextDecoder().decode(await snapshots.blob(entry?.sha ?? ""))).toBe("one\r\ntwo\r\n")
    expect((await snapshots.hashes(["crlf.txt"])).get("crlf.txt")).toBe(entry?.sha)
    expect(readdirSync(marks)).toEqual([])
  } finally {
    rmSync(join(home, ".gitconfig"))
  }
})

test("a snapshot stays readable after the project rewrites its history and drops the old objects", async () => {
  const dir = folder({ "a.txt": "a\n", "src/b.txt": "b\n" }, true)
  const blobs = [git(dir, "rev-parse", "HEAD:a.txt"), git(dir, "rev-parse", "HEAD:src/b.txt")]
  const snapshots = await opened(dir)
  const clean = await taken(snapshots, "clean")

  const branch = git(dir, "rev-parse", "--abbrev-ref", "HEAD")
  git(dir, "checkout", "-q", "--orphan", "rewritten")
  writeFileSync(join(dir, "a.txt"), "rewritten\n")
  git(dir, "rm", "-q", "-r", "--cached", "src")
  rmSync(join(dir, "src"), { recursive: true })
  git(dir, "commit", "-qam", "rewritten")
  git(dir, "branch", "-q", "-D", branch)
  git(dir, "reflog", "expire", "--expire=now", "--all")
  git(dir, "gc", "-q", "--prune=now")
  const later = await taken(snapshots, "later")

  expect([...(await snapshots.entries(clean, ["a.txt", "src/b.txt"])).keys()]).toEqual(["a.txt", "src/b.txt"])
  expect((await snapshots.changes(clean, later)).map(({ path, status }) => `${status} ${path}`)).toEqual([
    "M a.txt",
    "D src/b.txt",
  ])
  expect(await snapshots.missing(blobs)).toEqual(new Set(blobs))
})

test("a folder outside git is snapshotted without its dependency folders", async () => {
  const dir = folder({ "notes.md": "notes\n", "node_modules/x/index.js": "x\n" }, false)
  const snapshots = await opened(dir)
  const tree = await taken(snapshots, "plain")

  expect([...(await snapshots.entries(tree, ["notes.md", "node_modules/x/index.js"])).keys()]).toEqual(["notes.md"])
})

test("the home directory itself is not tracked", async () => {
  expect(await openSnapshots(home)).toBeNull()
})

test("an untracked file over 10 MB is never stored, also when it grows past the limit later", async () => {
  const dir = folder({ "a.txt": "a\n" }, true)
  const big = new Uint8Array(11 * 1024 * 1024)
  writeFileSync(join(dir, "big.bin"), big)
  writeFileSync(join(dir, "grows.log"), "small\n")
  const snapshots = await opened(dir)
  const first = await taken(snapshots, "big-1")
  writeFileSync(join(dir, "grows.log"), big)
  // big.bin is excluded now, so it no longer shows among untracked files, and must not slip back in.
  const second = await taken(snapshots, "big-2")

  expect([...(await snapshots.entries(first, ["big.bin", "grows.log"])).keys()]).toEqual(["grows.log"])
  expect((await snapshots.entries(second, ["big.bin", "grows.log"])).size).toBe(0)
})

test("a nested repository with nothing committed is left out as unknown and does not stop snapshots", async () => {
  const dir = folder({ "a.txt": "a\n" }, true)
  const nested = join(dir, "newapp")
  mkdirSync(nested)
  writeFileSync(join(nested, "main.rs"), "fn main() {}\n")
  git(nested, "init", "-q")
  const snapshots = await opened(dir)
  const fresh = await snapshots.take("fresh-1")
  const before = fresh?.tree ?? ""
  git(nested, "add", "-A")
  git(nested, "commit", "-qm", "first")
  const after = await taken(snapshots, "fresh-2")

  expect([...(await snapshots.entries(before, ["a.txt", "newapp", "newapp/main.rs"])).keys()]).toEqual(["a.txt"])
  expect(fresh?.unknown).toEqual(["newapp/"])
  expect((await snapshots.entries(after, ["newapp"])).get("newapp")?.mode).toBe("160000")
})

test("a file git cannot read is listed as unknown, untracked or with an edit, and so is a big file left out", async () => {
  const dir = folder({ "a.txt": "a\n", "tracked.txt": "committed\n" }, true)
  writeFileSync(join(dir, "tracked.txt"), "edit\n")
  writeFileSync(join(dir, "secret.txt"), "existed before\n")
  writeFileSync(join(dir, "big.bin"), new Uint8Array(11 * 1024 * 1024))
  chmodSync(join(dir, "tracked.txt"), 0o000)
  chmodSync(join(dir, "secret.txt"), 0o000)
  try {
    const snapshots = await opened(dir)
    const snapshot = await snapshots.take("unreadable")

    expect(snapshot?.unknown.toSorted()).toEqual(["big.bin", "secret.txt", "tracked.txt"])
  } finally {
    chmodSync(join(dir, "tracked.txt"), 0o644)
    chmodSync(join(dir, "secret.txt"), 0o644)
  }
})

test("a folder git cannot open is listed as unknown, with the tracked and untracked files in it", async () => {
  const dir = folder({ "a.txt": "a\n", "locked/tracked.txt": "committed\n" }, true)
  writeFileSync(join(dir, "locked/tracked.txt"), "edit\n")
  writeFileSync(join(dir, "locked/untracked.txt"), "mine\n")
  chmodSync(join(dir, "locked"), 0o000)
  try {
    const snapshots = await opened(dir)
    const snapshot = await snapshots.take("locked")

    expect(snapshot?.unknown).toContain("locked/")
  } finally {
    chmodSync(join(dir, "locked"), 0o755)
  }
})

test("a file the project's filters or line endings changed is stored as the bytes on disk", async () => {
  writeFileSync(join(home, ".gitconfig"), `[filter "pointer"]\n\tclean = sed 's/^/pointer to /'\n`)
  try {
    const dir = folder(
      {
        ".gitattributes": "* text=auto\n*.bin filter=pointer\n",
        "crlf.txt": "one\r\ntwo\r\n",
        '"quoted".txt': "three\r\n",
        "data.bin": "payload\n",
        "raw.dat": "\0\nbinary\n\0",
      },
      true,
    )
    const committed = await Bun.$`git -C ${dir} cat-file blob HEAD:data.bin`.text()
    const snapshots = await opened(dir)
    const tree = await taken(snapshots, "raw")
    const entries = await snapshots.entries(tree, ["crlf.txt", '"quoted".txt', "data.bin", "raw.dat"])
    const blobs = await snapshots.blobs([...[...entries.values()].map(({ sha }) => sha), "0".repeat(40)])
    const bytes = (path: string) => new TextDecoder().decode(blobs.get(entries.get(path)?.sha ?? ""))

    expect(committed).toBe("pointer to payload\n")
    expect(blobs.size).toBe(4)
    expect(bytes("crlf.txt")).toBe("one\r\ntwo\r\n")
    expect(bytes('"quoted".txt')).toBe("three\r\n")
    expect(bytes("data.bin")).toBe("payload\n")
    expect(bytes("raw.dat")).toBe("\0\nbinary\n\0")
  } finally {
    rmSync(join(home, ".gitconfig"))
  }
})

test("an ignored tracked file that cannot be read is unknown, and stored again once it can be", async () => {
  const dir = folder({ ".gitignore": "*.local\n", "cfg.local": "c\n" }, false)
  git(dir, "init", "-q")
  git(dir, "add", "-A")
  git(dir, "add", "-f", "cfg.local")
  git(dir, "commit", "-qm", "first")
  chmodSync(join(dir, "cfg.local"), 0o000)
  try {
    const snapshots = await opened(dir)
    const locked = await snapshots.take("locked-cfg")
    chmodSync(join(dir, "cfg.local"), 0o644)
    const readable = await taken(snapshots, "readable-cfg")

    expect(locked?.unknown).toContain("cfg.local")
    expect((await snapshots.entries(readable, ["cfg.local"])).has("cfg.local")).toBe(true)
  } finally {
    chmodSync(join(dir, "cfg.local"), 0o644)
  }
})

test("drop removes a snapshot's ref", async () => {
  const snapshots = await opened(folder({ "a.txt": "a\n" }, true))
  await snapshots.take("gone")
  await snapshots.drop("gone")
  expect(git(snapshots.store, "--git-dir=git", "for-each-ref", "refs/yc/gone")).toBe("")
})

test("a stored folder that becomes a repository later is left out as unknown", async () => {
  const dir = folder({ "a.txt": "a\n", "lib/a.txt": "lib\n" }, false)
  const snapshots = await opened(dir)
  const before = await taken(snapshots, "lib-plain")
  git(join(dir, "lib"), "init", "-q")
  const after = await snapshots.take("lib-repo")

  expect((await snapshots.entries(before, ["lib/a.txt"])).has("lib/a.txt")).toBe(true)
  expect(after?.unknown).toEqual(["lib/"])
  expect([...(await snapshots.entries(after?.tree ?? "", ["a.txt", "lib/a.txt"])).keys()]).toEqual(["a.txt"])
})
