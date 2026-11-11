import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { oldFolders } from "./paths.ts"

// Brings the folders YellowCode used before (~/.config/yellowcode, ~/.local/share/yellowcode, ~/.cache/yellowcode, or
// where the XDG variables put them) into ~/.yellowcode, once. An older YellowCode that is still running keeps writing
// to the old folders afterwards, so a marker says the move has run and nothing is ever moved a second time.

export type Moved = { root: string; moved: number; left: string[] }
type Options = {
  env?: Record<string, string | undefined>
  home?: string
  rename?: typeof renameSync
  waitMs?: number
}

const MARKER = "moved.json"
const LOCK = "move.lock"
// Folders whose entries stand alone (a theme, a mod, an agent file, a project's snapshots) move entry by entry, so
// they merge with a folder that is already there. Anything else that exists at the destination stays where it was.
const MERGED = new Set(["themes", "mods", "mod-data", "agents", "snapshots"])
const JUNK = ".DS_Store"

const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false })
const isFolder = (path: string) => stat(path)?.isDirectory() === true

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

// True when `from` is now at `to`. Never replaces what is at `to`.
function moveEntry(from: string, to: string, rename: typeof renameSync): boolean {
  if (stat(to)) return false
  try {
    const target = stat(from)?.isSymbolicLink() ? readlinkSync(from) : null
    if (target !== null && !isAbsolute(target)) {
      // A relative link would point somewhere else from the new folder.
      symlinkSync(resolve(dirname(from), target), to)
      unlinkSync(from)
    } else {
      rename(from, to)
    }
    return true
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) return false
  }
  // Another filesystem: copy, and remove the source only once the whole copy is there.
  try {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
  } catch {
    rmSync(to, { recursive: true, force: true })
    return false
  }
  rmSync(from, { recursive: true, force: true })
  return true
}

// Removes a folder that holds nothing (Finder's .DS_Store aside). False when it is still there.
function removeEmpty(folder: string): boolean {
  try {
    if (readdirSync(folder).every((name) => name === JUNK)) rmSync(join(folder, JUNK), { force: true })
    rmdirSync(folder)
    return true
  } catch {
    return false
  }
}

// A project's snapshots that a running YellowCode has open: each process works in index-<pid>/ there.
function inUse(store: string): boolean {
  try {
    return readdirSync(store).some((name) => {
      const pid = /^index-(\d+)$/.exec(name)?.[1]
      return pid !== undefined && Number(pid) !== process.pid && alive(Number(pid))
    })
  } catch {
    return false
  }
}

// An older version that is still running keeps taking snapshots where it opened them, so those are copied and its
// own stay with it.
function copyEntry(from: string, to: string): boolean {
  if (stat(to)) return false
  try {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    return true
  } catch {
    rmSync(to, { recursive: true, force: true })
    return false
  }
}

function moveInto(from: string, to: string, rename: typeof renameSync, within: string | null): number {
  const names = readdirSync(from).filter((name) => name !== JUNK)
  if (names.length > 0) mkdirSync(to, { recursive: true })
  let moved = 0
  for (const name of names) {
    const source = join(from, name)
    const target = join(to, name)
    if (within === "" && MERGED.has(name) && isFolder(source) && (isFolder(target) || !stat(target))) {
      moved += moveInto(source, target, rename, name)
      removeEmpty(source)
    } else if (within === "snapshots" && inUse(source) ? copyEntry(source, target) : moveEntry(source, target, rename))
      moved++
  }
  return moved
}

// Null when someone else holds the lock and the move did not finish in time, or it has already run.
function lock(root: string, waitMs: number): (() => void) | null {
  const file = join(root, LOCK)
  const until = Date.now() + waitMs
  while (true) {
    if (stat(join(root, MARKER))) return null
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" })
      return () => rmSync(file, { force: true })
    } catch {
      // Held by another process, or left by one that died.
    }
    let owner = 0
    try {
      owner = Number(readFileSync(file, "utf8"))
    } catch {
      continue
    }
    // Two processes that both take over a dead one's lock move side by side; every entry still goes over with one
    // rename that replaces nothing, so that is slower, not unsafe.
    if (owner > 0 && !alive(owner)) rmSync(file, { force: true })
    else if (Date.now() > until) return null
    else Bun.sleepSync(25)
  }
}

// Null when there was nothing to do here: YELLOWCODE_HOME is set, the move ran before, or another process is at it.
export function moveHome(options: Options = {}): Moved | null {
  const env = options.env ?? process.env
  if (env["YELLOWCODE_HOME"]) return null
  const home = options.home ?? homedir()
  const root = join(home, ".yellowcode")
  const marker = join(root, MARKER)
  if (stat(marker)) return null
  let unlock: (() => void) | null = null
  try {
    mkdirSync(root, { recursive: true })
    unlock = lock(root, options.waitMs ?? 10_000)
    if (!unlock) return null
    const old = oldFolders(env, home)
    const result: Moved = { root, moved: 0, left: [] }
    for (const [from, to] of [
      [old.config, root],
      [old.data, root],
      [old.cache, join(root, "cache")],
    ] as const) {
      const found = stat(from)
      if (!found) continue
      // A linked folder belongs to whatever it points at (a dotfiles repository), so nothing leaves it.
      if (found.isDirectory()) {
        try {
          result.moved += moveInto(from, to, options.rename ?? renameSync, from === old.cache ? null : "")
        } catch {
          // What did not move is still in the old folder, which is reported below.
        }
        if (removeEmpty(from)) continue
      }
      result.left.push(from)
    }
    writeFileSync(
      marker,
      `${JSON.stringify({ at: new Date().toISOString(), moved: result.moved, left: result.left })}\n`,
    )
    return result
  } catch {
    return null
  } finally {
    unlock?.()
  }
}

// What the user is told, once: nothing when nothing moved and nothing stayed behind.
export function moveLines(result: Moved | null, home = homedir()): string[] {
  if (!result) return []
  const short = (path: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)
  const lines: string[] = []
  if (result.moved > 0) lines.push(`Your settings and data moved to ${short(result.root)}`)
  if (result.left.length > 0) lines.push(`Some files stayed behind in ${result.left.map(short).join(", ")}`)
  return lines
}
