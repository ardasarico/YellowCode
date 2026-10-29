/* oxlint-disable no-await-in-loop */
import {
  accessSync,
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { lstat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { log } from "../log/log.ts"
import { projectKey } from "../project-key.ts"
import { alive, type GitRun, gitEnv, runGit } from "./common.ts"

// Paths are relative to `root`, with `/` separators, as git prints them.
export type Change = { path: string; status: "A" | "D" | "M" | "T"; plus: number | null; minus: number | null }
export type TreeEntry = { mode: string; sha: string }
// `unknown` lists the paths git could not read: the snapshot does not hold what was on disk there. A path ending in
// "/" stands for everything under it.
export type Taken = { tree: string; unknown: string[] }

export type Snapshots = {
  root: string
  store: string
  // The snapshot's tree is kept under refs/yc/<id>; null when it could not be taken, or `skip` holds once its turn in
  // the queue comes.
  take: (id: string, skip?: () => boolean) => Promise<Taken | null>
  // Removes a snapshot nothing will use, so pruning has nothing left to find.
  drop: (id: string) => Promise<void>
  // Line counts are null for binary files.
  changes: (from: string, to: string) => Promise<Change[]>
  entries: (tree: string, paths: readonly string[]) => Promise<Map<string, TreeEntry>>
  blob: (sha: string) => Promise<Uint8Array>
  // Many blobs in one git call. A sha the store cannot find is left out of the map.
  blobs: (shas: readonly string[]) => Promise<Map<string, Uint8Array>>
  // The blob sha a file or symlink would have now, or null when neither is at the path.
  hashes: (paths: readonly string[]) => Promise<Map<string, string | null>>
  missing: (shas: readonly string[]) => Promise<Set<string>>
  ignored: (paths: readonly string[]) => Promise<Set<string>>
  // A tree under refs/yc/<id> that holds each path with the bytes of its source file (claude's own backups).
  plant: (id: string, files: readonly Planted[]) => Promise<Taken>
}

export type Planted = { path: string; source: string; mode: "100644" | "100755" }

type Project = { root: string; gitDir: string; commonDir: string; format: string }

const FIRST_LISTING_MS = 3000
const UNTRACKED_LIMIT = 2 * 1024 * 1024
const DEPENDENCY_FOLDERS = ["node_modules/", ".venv/", "venv/", "__pycache__/", "target/", ".gradle/"]
const ATTRIBUTES = "* -text -filter -ident -working-tree-encoding\n"
const CONFIG = "[gc]\n\tauto = 0\n[core]\n\tautocrlf = false\n"
const ARGS_CHUNK = 500

const queues = new Map<string, Promise<unknown>>()

function queued<T>(store: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(store) ?? Promise.resolve()).then(task)
  queues.set(
    store,
    next.catch(() => {}),
  )
  return next
}

async function git(
  args: string[],
  options: { cwd: string; env: Record<string, string>; input?: string | Uint8Array; timeoutMs?: number },
): Promise<GitRun> {
  const run = await runGit(args, options)
  // Some callers accept a non-zero code, so a killed git must not reach them.
  if (run.killed !== null) throw new Error(`git ${args[0]} was killed (${run.killed})`)
  return run
}

const failed = (what: string, result: GitRun) => new Error(`git ${what} failed: ${result.stderr}`)
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const fields = (bytes: Uint8Array) => text(bytes).split("\0").filter(Boolean)

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = []
  for (let at = 0; at < items.length; at += ARGS_CHUNK) result.push(items.slice(at, at + ARGS_CHUNK))
  return result
}

async function findProject(cwd: string): Promise<Project | null> {
  const run = await git(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir", "--show-object-format"],
    { cwd, env: gitEnv({}) },
  )
  if (run.code !== 0) return null
  const [root, gitDir, commonDir, format] = text(run.stdout).split("\n")
  if (!root || !gitDir || !commonDir || !format) return null
  return { root: realpathSync(root), gitDir, commonDir, format }
}

function linesOf(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n")
  } catch {
    return []
  }
}

function appendLines(path: string, lines: string[]): void {
  const present = new Set(linesOf(path))
  const added = [...new Set(lines)].filter((line) => line.trim() !== "" && !present.has(line))
  if (added.length > 0) appendFileSync(path, `${added.join("\n")}\n`)
}

function excludeLine(path: string): string | null {
  if (path.includes("\n")) return null
  return `/${path.replace(/[\\*?[]/g, "\\$&").replace(/ $/, "\\ ")}`
}

// Git splits the variable on ":" unless an entry is C-quoted.
function quoted(path: string): string {
  return `"${path.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`
}

const ADD_RETRIES = 5

// hash-object --stdin-paths reads lines and unquotes a line starting with a quote.
const unsafeLine = (path: string) => path.includes("\n") || path.startsWith('"')
// Hashing every tracked file took about 0.7 s for 30k files on an M4 Pro. Past this limit snapshots turn off for the
// process rather than store filtered blobs.
const RAW_CHECK_MS = 10_000

// The paths in git's messages about files and folders it could not read. git prints names raw, newlines included,
// so the messages are matched across the whole output.
const UNREAD = [
  /could not open directory '([\s\S]+?\/)': (?=[A-Z])/g,
  /unable to access '([\s\S]+?\/)\.gitignore': (?=[A-Z])/g,
  /unable to stat '([\s\S]+?)': (?=[A-Z])/g,
  /unable to index file '([\s\S]+?)'(?=\n|$)/g,
  /error: open\("([\s\S]+?)"\): (?=[A-Z])/g,
]
// A bare "<path>: <reason>" line, looked for once the messages above are cut out.
const BARE = /(?:^|\n)(?!(?:warning|error|fatal|hint): )([^\n]+): [A-Z][^\n:']*(?=\n|$)/g

function unreadPaths(stderr: string): string[] {
  const paths: string[] = []
  let rest = stderr
  for (const pattern of UNREAD) {
    rest = rest.replace(pattern, (_match, path: string) => {
      paths.push(path)
      return ""
    })
  }
  for (const match of rest.matchAll(BARE)) if (match[1]) paths.push(match[1])
  return paths
}

// Each process works in index-<pid>/. Our own pid's folder is left over from an earlier process too.
function removeStaleIndexes(store: string): void {
  for (const name of readdirSync(store)) {
    const pid = /^index-(\d+)$/.exec(name)?.[1]
    if (pid !== undefined && (Number(pid) === process.pid || !alive(Number(pid))))
      rmSync(join(store, name), { recursive: true, force: true })
  }
}

// A split index keeps its other half in a sharedindex file, which git looks for beside the index it reads.
function copyIndex(gitDir: string, to: string): boolean {
  const source = join(gitDir, "index")
  if (!existsSync(source)) return false
  const bytes = readFileSync(source)
  writeFileSync(to, bytes)
  for (const name of readdirSync(gitDir)) {
    const shared = join(dirname(to), name)
    const sha = /^sharedindex\.([0-9a-f]+)$/.exec(name)?.[1]
    if (sha && !existsSync(shared) && bytes.includes(Buffer.from(sha, "hex"))) copyFileSync(join(gitDir, name), shared)
  }
  return true
}

// Built beside the final path and renamed into place, so a second window opening the same store sees either nothing
// or a finished repository.
async function createRepo(gitDir: string, format: string | null): Promise<void> {
  const temp = `${gitDir}.new-${process.pid}`
  rmSync(temp, { recursive: true, force: true })
  const formatArg = format === null ? [] : [`--object-format=${format}`]
  const run = await git(["init", "--bare", "--quiet", "--template=", ...formatArg, temp], {
    cwd: dirname(gitDir),
    env: gitEnv({}),
  })
  if (run.code !== 0) throw new Error(`git init failed: ${run.stderr}`)
  appendFileSync(join(temp, "config"), CONFIG)
  mkdirSync(join(temp, "info"), { recursive: true })
  writeFileSync(join(temp, "info", "attributes"), ATTRIBUTES)
  try {
    renameSync(temp, gitDir)
  } catch {
    rmSync(temp, { recursive: true, force: true })
  }
}

// `onOff` gets a short reason, safe to show, when no store is opened.
export async function openSnapshots(cwd: string, onOff?: (reason: string) => void): Promise<Snapshots | null> {
  const off = (reason: string, detail = reason) => {
    log.info("snapshots off", { cwd, reason: detail })
    onOff?.(reason)
    return null
  }
  let project: Project | null
  let root: string
  let home: string
  try {
    project = await findProject(cwd)
    root = project?.root ?? realpathSync(cwd)
    home = realpathSync(process.env["HOME"] || homedir())
  } catch (error) {
    return off("could not read the folder", String(error))
  }
  if (root === "/") return off("the folder is /")
  if (root === home) return off("the folder is the home directory")

  const base =
    process.env["YELLOWCODE_SNAPSHOT_DIR"] ||
    join(process.env["XDG_DATA_HOME"] || join(home, ".local", "share"), "yellowcode", "snapshots")
  const store = join(base, projectKey(root))
  const gitDir = join(store, "git")
  const work = join(store, `index-${process.pid}`)
  const index = join(work, "index")
  const exclude = join(gitDir, "info", "exclude")
  const own = gitEnv({ GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_INDEX_FILE: index })
  // Git refreshes the mtime of an object it would write that an alternate already holds, which would touch the
  // project's .git. So the project's objects are borrowed only by commands that write none.
  const borrowing = project
    ? { ...own, GIT_ALTERNATE_OBJECT_DIRECTORIES: quoted(realpathSync(join(project.commonDir, "objects"))) }
    : own
  const run = (
    args: string[],
    {
      writes,
      literal = true,
      index: indexFile,
      ...options
    }: { input?: string | Uint8Array; timeoutMs?: number; writes?: boolean; literal?: boolean; index?: string } = {},
  ) => {
    let env = writes ? own : borrowing
    if (literal) env = { ...env, GIT_LITERAL_PATHSPECS: "1" }
    if (indexFile) env = { ...env, GIT_INDEX_FILE: indexFile }
    return git(args, { cwd: root, env, ...options })
  }

  // Paths the project's git tracks, read again from a copy of its index whenever that index changes. Every other
  // file counts as untracked.
  const tracked = new Set<string>()
  let trackedKey: string | null = null
  const refreshTracked = async (): Promise<{ added: string[]; removed: string[] }> => {
    const stat = project ? lstatSync(join(project.gitDir, "index"), { throwIfNoEntry: false }) : undefined
    const key = stat ? `${stat.ino} ${stat.size} ${stat.mtimeMs}` : ""
    if (key === trackedKey) return { added: [], removed: [] }
    const copy = join(work, "project")
    let now = new Set<string>()
    if (project && copyIndex(project.gitDir, copy)) {
      const listing = await run(["ls-files", "-z"], { index: copy })
      if (listing.code !== 0) throw failed("ls-files", listing)
      now = new Set(fields(listing.stdout))
    }
    const first = trackedKey === null
    const added = first ? [] : [...now].filter((path) => !tracked.has(path))
    const removed = first ? [] : [...tracked].filter((path) => !now.has(path))
    tracked.clear()
    for (const path of now) tracked.add(path)
    trackedKey = key
    return { added, removed }
  }

  const ignoredPaths = async (paths: readonly string[]): Promise<Set<string>> => {
    if (paths.length === 0) return new Set()
    // check-ignore takes plain paths and refuses the literal pathspec setting.
    const check = await run(["check-ignore", "--no-index", "-z", "--stdin"], {
      input: `${paths.join("\0")}\0`,
      literal: false,
    })
    if (check.code !== 0 && check.code !== 1) throw failed("check-ignore", check)
    return new Set(fields(check.stdout))
  }

  // add -A would run status inside each submodule under the submodule's own config, so gitlinks are kept out of it
  // and update-index sets them to the submodule's HEAD instead.
  const gitlinks = new Set<string>()

  const forget = async (paths: string[]) => {
    if (paths.length === 0) return
    const removed = await run(["update-index", "--force-remove", "-z", "--stdin"], { input: `${paths.join("\0")}\0` })
    if (removed.code !== 0) throw failed("update-index", removed)
  }

  // Untracked files over the limit are never stored. They are excluded for good, so they stay out after they leave
  // the untracked listing, and dropped from the store's index when they grew there.
  const dropBig = async (untracked: string[], timeoutMs?: number): Promise<{ big: string[]; nested: string[] }> => {
    const others = await run(["ls-files", "-z", "--others", "--exclude-standard"], { timeoutMs })
    if (others.timedOut) throw new Error(`listing took over ${timeoutMs} ms`)
    if (others.code !== 0) throw failed("ls-files", others)
    const changed = await run(["diff-files", "--name-only", "-z", "--ignore-submodules=dirty"])
    if (changed.code !== 0) throw failed("diff-files", changed)
    const candidates = [...fields(others.stdout), ...fields(changed.stdout), ...untracked].filter(
      (path) => !tracked.has(path),
    )
    const sized = await Promise.all(
      candidates.map(async (path) => {
        const stat = await lstat(join(root, path)).catch(() => null)
        return stat?.isFile() && stat.size > UNTRACKED_LIMIT ? [path] : []
      }),
    )
    const big = [...new Set(sized.flat())]
    appendLines(
      exclude,
      big.flatMap((path) => excludeLine(path) ?? []),
    )
    await forget(big)
    // ls-files shows a nested repository as its folder with a trailing slash.
    const nested = fields(others.stdout).flatMap((path) => (path.endsWith("/") ? [path.slice(0, -1)] : []))
    return { big, nested }
  }

  // A folder whose files are already in the store's index and which later got its own .git (git init in it) is a
  // nested repository too, which add -A would not notice. Its file entries leave the index.
  const nestedInIndex = async (): Promise<string[]> => {
    const listing = await run(["ls-files", "-z"])
    if (listing.code !== 0) throw failed("ls-files", listing)
    const paths = fields(listing.stdout)
    const folders = new Set<string>()
    for (const path of paths) {
      for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
        const folder = path.slice(0, slash)
        if (folders.has(folder)) break
        folders.add(folder)
      }
    }
    const repos = [...folders].filter((folder) => existsSync(join(root, folder, ".git")))
    const outer = repos.filter((repo) => !repos.some((other) => repo.startsWith(`${other}/`)))
    if (outer.length === 0) return []
    await forget(paths.filter((path) => outer.some((repo) => path.startsWith(`${repo}/`))))
    return outer
  }

  // Sorts the gitlinks and nested repositories: repositories, submodule folders not checked out (kept as they are),
  // and folders whose .git is gone, which lose their gitlink and are stored as plain files again.
  const sortGitlinks = async (nested: string[]): Promise<{ repos: string[]; kept: string[] }> => {
    const repos: string[] = []
    const kept: string[] = []
    const stale: string[] = []
    for (const path of new Set([...gitlinks, ...nested])) {
      const full = join(root, path)
      const stat = lstatSync(full, { throwIfNoEntry: false })
      if (stat?.isDirectory() && existsSync(join(full, ".git"))) repos.push(path)
      else if (stat?.isDirectory() && readdirSync(full).length === 0) kept.push(path)
      else stale.push(path)
    }
    await forget(stale.filter((path) => gitlinks.has(path)))
    return { repos, kept }
  }

  // A repository with nothing committed has no HEAD to point at, so it gets no entry and the snapshot goes on.
  // Returns the repositories left out, whose files the snapshot then does not hold.
  const linkRepos = async (repos: string[], kept: string[]): Promise<string[]> => {
    gitlinks.clear()
    for (const path of kept) gitlinks.add(path)
    if (repos.length === 0) return []
    const all = await run(["update-index", "--add", "--remove", "-z", "--stdin"], {
      input: `${repos.join("\0")}\0`,
      writes: true,
    })
    const left: string[] = []
    for (const path of repos) {
      const one = all.code === 0 ? all : await run(["update-index", "--add", "--remove", "--", path], { writes: true })
      if (one.code === 0) gitlinks.add(path)
      else left.push(path)
    }
    if (left.length > 0) log.warn("snapshot leaves out nested repositories with nothing committed", left)
    return left
  }

  // Only blobs may be borrowed. Trees the copied index reused from the project are copied in, so a rewrite and gc
  // there cannot make a snapshot unreadable.
  const ownTrees = async (tree: string) => {
    const walk = await run(["rev-list", "--objects", "--filter=blob:none", "--quiet", tree], { writes: true })
    if (walk.code === 0) return
    const pack = await run(["pack-objects", "--revs", "--stdout", "--filter=blob:none", "-q"], { input: `${tree}\n` })
    if (pack.code !== 0) throw failed("pack-objects", pack)
    const stored = await run(["index-pack", "--stdin"], { input: pack.stdout, writes: true })
    if (stored.code !== 0) throw failed("index-pack", stored)
  }

  // Files the user told git not to look at would never change in a snapshot.
  const unflag = async (): Promise<boolean> => {
    const flagged = await run(["ls-files", "-z", "-v", "-s"])
    if (flagged.code !== 0) return false
    const paths: string[] = []
    for (const line of fields(flagged.stdout)) {
      const path = line.slice(line.indexOf("\t") + 1)
      if (line.slice(2, 8) === "160000") gitlinks.add(path)
      if (/^([a-z]|S) /.test(line)) paths.push(path)
    }
    for (const chunk of chunks(paths)) {
      const cleared = await run(["update-index", "--no-assume-unchanged", "--no-skip-worktree", "--", ...chunk])
      if (cleared.code !== 0) return false
    }
    return true
  }

  // The copied index holds the project's blob shas, which its filters and line ending conversion made. A snapshot
  // must hold the bytes on disk, so the first take checks every copied entry.
  let rawChecked = false
  // Tracked files the check above could not read. add -A alone would skip one that .gitignore matches.
  const dropped = new Set<string>()
  // Set when the check above runs too long: snapshots stay off for this process.
  let stopped: string | null = null

  // Entries whose bytes on disk hash differently from the copied sha are added again here, unfiltered.
  const rawEntries = async (): Promise<number> => {
    if (!existsSync(index)) return 0
    const listing = await run(["ls-files", "-z", "-s"])
    if (listing.code !== 0) throw failed("ls-files", listing)
    const copied: { path: string; sha: string }[] = []
    const unreadable: string[] = []
    for (const line of fields(listing.stdout)) {
      const entry = /^(100644|100755) (\w+) 0\t([\s\S]*)$/.exec(line)
      if (!entry?.[2] || !entry[3]) continue
      const full = join(root, entry[3])
      try {
        if (!lstatSync(full, { throwIfNoEntry: false })?.isFile()) continue
        accessSync(full, constants.R_OK)
        copied.push({ path: entry[3], sha: entry[2] })
      } catch {
        unreadable.push(entry[3])
      }
    }
    // Out of the index, a file git cannot read is reported as unknown on every take, and added by name once it can be.
    await forget(unreadable)
    for (const path of unreadable) dropped.add(path)
    const plain = copied.filter(({ path }) => !unsafeLine(path))
    const hashed = await run(["hash-object", "--no-filters", "--stdin-paths"], {
      input: plain.map(({ path }) => `${path}\n`).join(""),
      timeoutMs: RAW_CHECK_MS,
    })
    if (hashed.timedOut) {
      stopped = `checking the copied index took over ${RAW_CHECK_MS} ms`
      log.warn("snapshots off", { cwd, reason: stopped })
      throw new Error(stopped)
    }
    if (hashed.code !== 0) throw failed("hash-object", hashed)
    const shas = text(hashed.stdout).split("\n")
    const differ = plain.filter(({ sha }, at) => shas[at] !== sha).map(({ path }) => path)
    differ.push(...copied.filter(({ path }) => unsafeLine(path)).map(({ path }) => path))
    if (differ.length === 0) return 0
    // update-index skips an entry whose stat still matches, so the old entry goes first.
    await forget(differ)
    const added = await run(["update-index", "--add", "-z", "--stdin"], {
      input: `${differ.join("\0")}\0`,
      writes: true,
    })
    if (added.code !== 0) throw failed("update-index", added)
    return differ.length
  }

  const prepared = await queued(store, async () => {
    try {
      mkdirSync(store, { recursive: true, mode: 0o700 })
      if (!existsSync(join(gitDir, "HEAD"))) await createRepo(gitDir, project?.format ?? null)
      appendLines(
        exclude,
        project
          ? linesOf(join(project.commonDir, "info", "exclude")).filter((line) => !line.startsWith("#"))
          : DEPENDENCY_FOLDERS,
      )
      removeStaleIndexes(store)
      mkdirSync(work)
      // A copy git cannot read here is dropped and the store builds its own index.
      if (project && copyIndex(project.gitDir, index) && !(await unflag())) rmSync(index, { force: true })
      await refreshTracked()
      await dropBig([], FIRST_LISTING_MS)
      return null
    } catch (error) {
      return String(error)
    }
  })
  if (prepared !== null) return off("could not set up the snapshot store", prepared)

  // Paths add left out because it could not read them, apart from the ones left out on purpose.
  const unread = async (deliberate: Set<string>): Promise<string[]> => {
    const others = await run(["ls-files", "-z", "--others", "--exclude-standard"])
    if (others.code !== 0) throw failed("ls-files", others)
    const stale = await run(["diff-files", "--name-only", "-z", "--ignore-submodules=dirty"])
    if (stale.code !== 0) throw failed("diff-files", stale)
    const paths = [...fields(others.stdout), ...fields(stale.stdout)]
    return [...new Set(paths)].filter((path) => !path.endsWith("/") && !deliberate.has(path))
  }

  const snapshot = async (id: string): Promise<Taken & { trackedMs: number; bigCheckMs: number; nestedMs: number }> => {
    // A git killed mid-write leaves its lock behind. Only this process uses the folder, and takes run one at a time.
    rmSync(`${index}.lock`, { force: true })
    let started = performance.now()
    const { added, removed } = await refreshTracked()
    // A file the project force-tracked and then let go of is ignored again, so it leaves the store's index too.
    await forget([...(await ignoredPaths(removed))])
    const trackedMs = Math.round(performance.now() - started)
    if (!rawChecked) {
      started = performance.now()
      const rewritten = await rawEntries()
      log.info("snapshot raw check", { ms: Math.round(performance.now() - started), rewritten })
      rawChecked = true
    }
    started = performance.now()
    const { big, nested } = await dropBig(removed)
    const bigCheckMs = Math.round(performance.now() - started)
    started = performance.now()
    const inner = await nestedInIndex()
    const nestedMs = Math.round(performance.now() - started)
    const { repos, kept } = await sortGitlinks([...nested, ...inner])
    const outside = [...repos, ...kept].map((path) => `:(exclude,literal)${path}`)
    // One path git cannot read is left out of the snapshot rather than stopping it. A path that stops add anyway (a
    // file gone between listing and hashing, a folder it can list but not enter) is left out and add runs again.
    const unknownPaths = new Set<string>()
    const skipped: string[] = []
    let unreadable = false
    for (let attempt = 0; ; attempt++) {
      const pathspecs = [...outside, ...skipped.map((path) => `:(exclude,literal)${path.replace(/\/$/, "")}`)]
      const add = await run(["add", "--all", "--ignore-errors", "--", ".", ...pathspecs], {
        writes: true,
        literal: false,
      }).catch((error: unknown) => {
        // A file truncated while git maps it can kill git; the next attempt reads it again.
        if (attempt === ADD_RETRIES) throw error
        rmSync(`${index}.lock`, { force: true })
        return null
      })
      if (add === null) continue
      const found = unreadPaths(add.stderr)
      for (const path of found) unknownPaths.add(path)
      if (!add.stderr.includes("fatal:")) {
        unreadable = add.code !== 0
        break
      }
      const fresh = found.filter((path) => !skipped.includes(path))
      if (fresh.length === 0 || attempt === ADD_RETRIES) throw failed("add", add)
      skipped.push(...fresh)
    }
    // Files the project started tracking after open may be ignored or excluded here, so they are added by name.
    const files = added.filter(
      (path) => lstatSync(join(root, path), { throwIfNoEntry: false })?.isDirectory() === false,
    )
    for (const path of dropped) {
      try {
        accessSync(join(root, path), constants.R_OK)
        files.push(path)
        dropped.delete(path)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") dropped.delete(path)
        else unknownPaths.add(path)
      }
    }
    for (const chunk of chunks(files)) {
      const forced = await run(["add", "--force", "--ignore-errors", "--", ...chunk], { writes: true })
      if (forced.code !== 0 && forced.stderr.includes("fatal:")) throw failed("add", forced)
      for (const path of unreadPaths(forced.stderr)) unknownPaths.add(path)
      unreadable ||= forced.code !== 0
    }
    for (const path of await linkRepos(repos, kept)) unknownPaths.add(`${path}/`)
    // A name no exclude line can hold (one with a newline) was added again.
    await forget(big)
    if (unreadable)
      for (const path of await unread(new Set([...big, ...nested, ...repos, ...kept]))) unknownPaths.add(path)
    const unknown = [...unknownPaths]
    if (unknown.length > 0) log.warn("snapshot could not read some files", { id, unknown: unknown.slice(0, 20) })
    // Blobs of unchanged files stay in the project only, which a run without its objects counts as missing.
    const tree = await run(["write-tree", "--missing-ok"], { writes: true })
    if (tree.code !== 0) throw failed("write-tree", tree)
    const sha = text(tree.stdout).trim()
    await ownTrees(sha)
    const ref = await run(["update-ref", `refs/yc/${id}`, sha])
    if (ref.code !== 0) throw failed("update-ref", ref)
    return { tree: sha, unknown, trackedMs, bigCheckMs, nestedMs }
  }

  return {
    root,
    store,
    take: (id, skip) =>
      queued(store, async () => {
        if (skip?.()) return null
        if (stopped !== null) {
          log.warn("snapshot not taken", { id, reason: stopped })
          return null
        }
        const started = performance.now()
        try {
          const { tree, unknown, trackedMs, bigCheckMs, nestedMs } = await snapshot(id)
          const ms = Math.round(performance.now() - started)
          log.info("snapshot taken", { id, ms, trackedMs, bigCheckMs, nestedMs })
          return { tree, unknown }
        } catch (error) {
          log.warn("snapshot not taken", { id, ms: Math.round(performance.now() - started), reason: String(error) })
          return null
        }
      }),

    drop: (id) =>
      queued(store, async () => {
        const removed = await run(["update-ref", "-d", `refs/yc/${id}`])
        if (removed.code !== 0) throw failed("update-ref", removed)
      }),

    changes: (from, to) =>
      queued(store, async () => {
        const raw = await run(["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to])
        if (raw.code !== 0) throw failed("diff-tree", raw)
        const byPath = new Map<string, Change>()
        const tokens = fields(raw.stdout)
        for (let at = 0; at + 1 < tokens.length; at += 2) {
          const status = tokens[at]?.slice(-1)
          const path = tokens[at + 1] ?? ""
          if (status === "A" || status === "D" || status === "M" || status === "T")
            byPath.set(path, { path, status, plus: null, minus: null })
        }
        // Line counts read both blobs, and a borrowed one is gone once the project drops it, so they are left null.
        const numstat = await run(["diff-tree", "-r", "-z", "--no-renames", "--numstat", from, to])
        for (const token of numstat.code === 0 ? fields(numstat.stdout) : []) {
          const counts = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token)
          const change = counts ? byPath.get(counts[3] ?? "") : undefined
          if (counts && change) {
            change.plus = counts[1] === "-" ? null : Number(counts[1])
            change.minus = counts[2] === "-" ? null : Number(counts[2])
          }
        }
        return [...byPath.values()]
      }),

    entries: (tree, paths) =>
      queued(store, async () => {
        const wanted = new Set(paths)
        const found = new Map<string, TreeEntry>()
        for (const chunk of chunks([...wanted])) {
          const listing = await run(["ls-tree", "-z", "--full-tree", tree, "--", ...chunk])
          if (listing.code !== 0) throw failed("ls-tree", listing)
          for (const line of fields(listing.stdout)) {
            const entry = /^(\d+) \w+ (\w+)\t(.*)$/s.exec(line)
            if (entry?.[1] && entry[2] && entry[3] !== undefined && wanted.has(entry[3]))
              found.set(entry[3], { mode: entry[1], sha: entry[2] })
          }
        }
        return found
      }),

    blob: (sha) =>
      queued(store, async () => {
        const result = await run(["cat-file", "blob", sha])
        if (result.code !== 0) throw failed("cat-file", result)
        return result.stdout
      }),

    blobs: (shas) =>
      queued(store, async () => {
        const found = new Map<string, Uint8Array>()
        const unique = [...new Set(shas)]
        if (unique.length === 0) return found
        const batch = await run(["cat-file", "--batch"], { input: `${unique.join("\n")}\n` })
        if (batch.code !== 0) throw failed("cat-file", batch)
        // Each object is "<sha> <type> <size>\n<bytes>\n", or "<sha> missing\n".
        const out = batch.stdout
        let at = 0
        while (at < out.length) {
          const end = out.indexOf(10, at)
          if (end === -1) break
          const [sha = "", type, size] = text(out.subarray(at, end)).split(" ")
          at = end + 1
          if (size === undefined || type === "missing") continue
          found.set(sha, out.slice(at, at + Number(size)))
          at += Number(size) + 1
        }
        return found
      }),

    hashes: (paths) =>
      queued(store, async () => {
        const result = new Map<string, string | null>()
        const files: string[] = []
        for (const path of paths) {
          const full = join(root, path)
          const stat = lstatSync(full, { throwIfNoEntry: false })
          if (stat?.isFile()) files.push(path)
          else if (stat?.isSymbolicLink()) {
            // A symlink is stored as the text it points to, which hash-object would follow instead.
            const link = await run(["hash-object", "--stdin"], { input: readlinkSync(full, { encoding: "buffer" }) })
            if (link.code !== 0) throw failed("hash-object", link)
            result.set(path, text(link.stdout).trim())
          } else result.set(path, null)
        }
        for (const chunk of chunks(files)) {
          const hashed = await run(["hash-object", "--no-filters", "--", ...chunk])
          if (hashed.code !== 0) throw failed("hash-object", hashed)
          const shas = text(hashed.stdout).split("\n")
          chunk.forEach((path, at) => result.set(path, shas[at] ?? null))
        }
        return result
      }),

    missing: (shas) =>
      queued(store, async () => {
        const unique = [...new Set(shas)]
        if (unique.length === 0) return new Set<string>()
        const check = await run(["cat-file", "--batch-check"], { input: `${unique.join("\n")}\n` })
        if (check.code !== 0) throw failed("cat-file", check)
        const lines = text(check.stdout).split("\n")
        return new Set(lines.flatMap((line) => (line.endsWith(" missing") ? [line.slice(0, -" missing".length)] : [])))
      }),

    ignored: (paths) => queued(store, () => ignoredPaths(paths)),

    plant: (id, files) =>
      queued(store, async () => {
        const temp = join(work, `plant-${process.pid}`)
        rmSync(temp, { force: true })
        try {
          if (files.length > 0) {
            const sources = `${files.map((file) => file.source).join("\n")}\n`
            const hashed = await run(["hash-object", "-w", "--no-filters", "--stdin-paths"], {
              writes: true,
              input: sources,
            })
            if (hashed.code !== 0) throw failed("hash-object", hashed)
            const shas = text(hashed.stdout).trim().split("\n")
            const info = files.map((file, at) => `${file.mode} ${shas[at]}\t${file.path}\0`).join("")
            const added = await run(["update-index", "-z", "--add", "--index-info"], {
              writes: true,
              index: temp,
              input: info,
            })
            if (added.code !== 0) throw failed("update-index", added)
          }
          const tree = await run(["write-tree"], { writes: true, index: temp })
          if (tree.code !== 0) throw failed("write-tree", tree)
          const sha = text(tree.stdout).trim()
          const ref = await run(["update-ref", `refs/yc/${id}`, sha])
          if (ref.code !== 0) throw failed("update-ref", ref)
          return { tree: sha, unknown: [] }
        } finally {
          rmSync(temp, { force: true })
        }
      }),
  }
}
