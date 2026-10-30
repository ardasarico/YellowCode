/* oxlint-disable no-await-in-loop */
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  type Stats,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { log } from "../log/log.ts"
import { blobId, covers, writeBeside } from "./common.ts"
import type { Change, Snapshots, Taken, TreeEntry } from "./snapshots.ts"

// Restore rules, applied to each path in order:
// 1. Every folder on the way is a real folder inside root, not a symlink.
// 2. An existing file is a regular file with one link.
// 3. A path the target holds as a symlink or gitlink is kept.
// 4. An existing file must still be what the safety snapshot saw, or it changed just now and is kept.
// 5. If the target has the path, its blob is written beside it and renamed over it; a missing blob keeps the file.
// 6. If the target lacks the path, delete it only when the undone turns made it, git does not ignore it and it was not
//    born before the target snapshot.
// 7. A file kept by rule 6 is still deleted when its bytes were just restored at another path (a move or copy).
// 8. Folders are never removed, and no whole-tree git operation is used.
// 9. A path the snapshots could not read is kept.

// Paths are relative to the snapshots' root, as in snapshots.ts.
export type Write = { path: string; kind: "create" | "update" }
// What the files go back to: a snapshot, or a map of path → blob (null: no file there) for some paths only. A path
// the map does not hold counts as unknown.
export type Target = Taken | { files: ReadonlyMap<string, TreeEntry | null> }
export type Kept = { path: string; reason: string }
export type RestoreResult = { restored: string[]; deleted: string[]; kept: Kept[] }

export type RestoreInput = {
  snapshots: Snapshots
  target: Target
  // When the target snapshot started (ms since the epoch). A file born before it is not new.
  targetAt: number
  // For paths whose target comes from another snapshot (a /redo after several rewinds): that snapshot's start.
  targetAts?: ReadonlyMap<string, number>
  // R, taken just before the restore.
  safety: Taken
  // The latest undone turn's after snapshot. For /redo, the one taken after the rewind.
  after: Taken
  paths: readonly string[]
  // Paths the undone turns created: createdIn(the undone turns' changes). For /redo, createdIn([changes(R0,
  // R_after)]).
  created: readonly string[]
  // What Write and Edit reported in the undone turns, oldest first.
  writes: readonly Write[]
  // /redo: a file that differs from `after` changed after the rewind and is kept.
  keepChanged?: boolean
}

type Step = {
  path: string
  target: TreeEntry | null
  // Blob shas of the regular file at the path, null when there is none.
  safety: string | null
  after: string | null
  unread: boolean
  missing: boolean
  created: boolean
  updated: boolean
  // The target holds a folder above the path as a nested repository.
  nested: boolean
  targetAt: number
}

export type RestorePlan = { snapshots: Snapshots; steps: Step[]; keepChanged: boolean }

type Found = { bytes: Buffer; mode: number; born: number }
// The disk as one restore sees it: folder listings read so far, by folder, and in a dry run the files it would have
// deleted and the folders it would have made.
type Disk = { names: Map<string, Set<string>>; dry: boolean; gone: Set<string>; made: Set<string> }

const REGULAR = new Set(["100644", "100755"])
const GITLINK = "160000"

// Paths whose first change in the turns, oldest turn first, is an add.
export function createdIn(turns: readonly (readonly Change[])[]): string[] {
  const first = new Map<string, Change["status"]>()
  for (const changes of turns) {
    for (const change of changes) if (!first.has(change.path)) first.set(change.path, change.status)
  }
  return [...first].flatMap(([path, status]) => (status === "A" ? [path] : []))
}

const outside = (path: string) =>
  path.split("/").some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")

const folderPaths = (path: string) =>
  path
    .split("/")
    .slice(0, -1)
    .map((_, at, parts) => parts.slice(0, at + 1).join("/"))

const regular = (entry: TreeEntry | null | undefined) => (entry && REGULAR.has(entry.mode) ? entry.sha : null)

export async function planRestore(input: RestoreInput): Promise<RestorePlan> {
  const { snapshots, target, safety, after } = input
  const paths = [...new Set(input.paths)].toSorted()
  const inside = paths.filter((path) => !outside(path))
  const above = [...new Set(inside.flatMap(folderPaths))]
  const targets = "files" in target ? target.files : await snapshots.entries(target.tree, inside)
  const gitlinks = "files" in target ? new Map<string, TreeEntry>() : await snapshots.entries(target.tree, above)
  const before = await snapshots.entries(safety.tree, inside)
  const later = await snapshots.entries(after.tree, inside)
  const missing = await snapshots.missing(inside.flatMap((path) => regular(targets.get(path)) ?? []))
  const unknown = [...("files" in target ? [] : target.unknown), ...safety.unknown, ...after.unknown]
  const created = new Set(input.created)
  // A create is reported only when the file was absent, so a path whose first write is one held nothing of the user's.
  const first = new Map<string, Write["kind"]>()
  for (const write of input.writes) if (!first.has(write.path)) first.set(write.path, write.kind)
  const updated = new Set([...first].flatMap(([path, kind]) => (kind === "update" ? [path] : [])))
  const steps = paths.map((path): Step => {
    const entry = outside(path) ? null : targets.get(path)
    return {
      path,
      target: entry ?? null,
      safety: regular(before.get(path)),
      after: regular(later.get(path)),
      unread: covers(unknown, path) || ("files" in target && entry === undefined),
      missing: entry ? missing.has(entry.sha) : false,
      created: created.has(path),
      updated: updated.has(path),
      nested: folderPaths(path).some((folder) => gitlinks.get(folder)?.mode === GITLINK),
      targetAt: input.targetAts?.get(path) ?? input.targetAt,
    }
  })
  return { snapshots, steps, keepChanged: input.keepChanged ?? false }
}

function holds(bytes: Uint8Array | null, sha: string | null): boolean {
  if (bytes === null || sha === null) return bytes === null && sha === null
  return blobId(bytes, sha) === sha
}

// On a case-insensitive disk lstat finds "README.md" under "Readme.md", which is another path to git.
function named(disk: Disk, dir: string, name: string): boolean {
  if (disk.made.has(dir)) return true
  let names = disk.names.get(dir)
  if (!names) {
    names = new Set(readdirSync(dir).map((found) => found.normalize()))
    disk.names.set(dir, names)
  }
  return names.has(name.normalize())
}

const gone = (error: unknown) =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")

// Rule 1: every folder on the way is a real folder inside root. With `create`, missing ones are made.
function folders(disk: Disk, root: string, path: string, create: boolean): string | null {
  if (outside(path)) return "outside the project"
  let dir = root
  for (const part of path.split("/").slice(0, -1)) {
    const next = join(dir, part)
    if (disk.made.has(next)) {
      dir = next
      continue
    }
    const stat = disk.gone.has(next) ? undefined : lstatSync(next, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) return "symlink in the path"
    if (stat?.isDirectory() && !named(disk, dir, part)) return "not a regular file"
    if (!stat?.isDirectory()) {
      if (!create) return null
      if (stat) return "could not write it"
      if (disk.dry) disk.made.add(next)
      else mkdirSync(next)
      disk.names.get(dir)?.add(part.normalize())
    }
    dir = next
  }
  return null
}

// Rule 2: the regular file at the path, null when nothing is there, or why it is kept.
function read(disk: Disk, full: string): Found | null | string {
  if (disk.gone.has(full)) return null
  let stat: Stats
  try {
    stat = lstatSync(full)
  } catch (error) {
    return gone(error) ? null : "could not read it"
  }
  if (!stat.isFile() || !named(disk, dirname(full), basename(full))) return "not a regular file"
  if (stat.nlink !== 1) return "hard link"
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd)
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) return "changed just now"
    return { bytes: readFileSync(fd), mode: stat.mode & 0o777, born: stat.birthtimeMs }
  } finally {
    closeSync(fd)
  }
}

// Rules 1–4 and 9, read from the disk as it is now.
function check(
  disk: Disk,
  root: string,
  step: Step,
  keepChanged: boolean,
): { reason: string; now?: undefined } | { reason: null; now: Found | null } {
  try {
    const outer = folders(disk, root, step.path, false)
    if (outer) return { reason: outer }
    const now = read(disk, join(root, step.path))
    if (typeof now === "string") return { reason: now }
    if (step.target && !REGULAR.has(step.target.mode)) return { reason: "not a regular file" }
    if (now && !holds(now.bytes, step.safety)) return { reason: "changed just now" }
    if (keepChanged && !holds(now?.bytes ?? null, step.after)) return { reason: "changed after the rewind" }
    if (step.unread) return { reason: "could not read it" }
    return { reason: null, now }
  } catch {
    return { reason: "could not read it" }
  }
}

// A file that stays keeps its permissions and takes only the executable bit from the tree.
function modeFor(entry: TreeEntry, now: Found | null): number {
  const exec = entry.mode === "100755"
  if (!now) return exec ? 0o755 : 0o644
  return exec ? now.mode | ((now.mode & 0o444) >> 2) : now.mode & ~0o111
}

// What a dry run checks in place of writing or deleting: the folder takes changes (or the nearest one that exists, for
// folders it would make), and the file is not locked (chflags uchg). A read-only file is still replaced, as a rename
// over it works.
function changeable(disk: Disk, full: string): boolean {
  let dir = dirname(full)
  while (disk.made.has(dir)) dir = dirname(dir)
  try {
    accessSync(dir, constants.W_OK)
  } catch {
    return false
  }
  if (disk.gone.has(full)) return true
  try {
    accessSync(full, constants.W_OK)
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "EPERM")
  }
  return true
}

// Rule 5: the blob goes to a file beside the path, which is renamed over it right after the checks run again.
function put(disk: Disk, root: string, step: Step, bytes: Uint8Array, mode: number, keepChanged: boolean) {
  const full = join(root, step.path)
  let temp: string | null = null
  try {
    const parents = folders(disk, root, step.path, true)
    if (parents) return parents
    if (disk.dry) return changeable(disk, full) ? check(disk, root, step, keepChanged).reason : "could not write it"
    temp = writeBeside(full, bytes, mode)
    const { reason } = check(disk, root, step, keepChanged)
    if (reason) {
      rmSync(temp, { force: true })
      return reason
    }
    renameSync(temp, full)
    disk.names.get(dirname(full))?.add(basename(full).normalize())
    return null
  } catch {
    if (temp) rmSync(temp, { force: true })
    return "could not write it"
  }
}

// With `dryRun` every check runs as it would, and nothing is written or deleted: the result says what a restore would
// do now. Only a .gitignore the restore would change is read as it is now, not as it would be.
export async function applyRestore(plan: RestorePlan, options: { dryRun?: boolean } = {}): Promise<RestoreResult> {
  const { snapshots, keepChanged } = plan
  const root = snapshots.root
  const dry = options.dryRun === true
  const disk: Disk = { names: new Map(), dry, gone: new Set(), made: new Set() }
  const restored: string[] = []
  const deleted: string[] = []
  const kept = new Map<string, string>()
  const written = new Set<string>()
  // Writes that failed on the disk, tried once more after the deletions (a file where a folder goes back).
  const retry: { step: Step; bytes: Uint8Array; mode: number }[] = []

  const write = async (steps: Step[]) => {
    const ready: { step: Step; entry: TreeEntry; mode: number }[] = []
    for (const step of steps) {
      if (step.target === null) continue
      const { reason, now } = check(disk, root, step, keepChanged)
      if (reason !== null) kept.set(step.path, reason)
      else if (step.missing) kept.set(step.path, "snapshot incomplete")
      else ready.push({ step, entry: step.target, mode: modeFor(step.target, now) })
    }
    // A dry run takes the blobs planRestore found as there.
    const blobs = dry
      ? new Map(ready.map(({ entry }) => [entry.sha, new Uint8Array()]))
      : await snapshots.blobs(ready.map(({ entry }) => entry.sha)).catch(() => new Map<string, Uint8Array>())
    for (const { step, entry, mode } of ready) {
      const bytes = blobs.get(entry.sha)
      const failed = bytes ? put(disk, root, step, bytes, mode, keepChanged) : "snapshot incomplete"
      if (failed === "could not write it" && bytes) retry.push({ step, bytes, mode })
      if (failed) kept.set(step.path, failed)
      else {
        restored.push(step.path)
        written.add(entry.sha)
      }
    }
  }

  const remove = async (steps: Step[], stale: boolean) => {
    const candidates: { step: Step; born: number }[] = []
    for (const step of steps) {
      if (step.target !== null) continue
      const { reason, now } = check(disk, root, step, keepChanged)
      if (reason) kept.set(step.path, reason)
      else if (now) candidates.push({ step, born: now.born })
    }
    const created = candidates.flatMap(({ step }) => (step.created ? [step.path] : []))
    const ignored = stale ? null : await snapshots.ignored(created).catch(() => null)
    for (const { step, born } of candidates) {
      if (step.nested) {
        kept.set(step.path, "inside another repository")
        continue
      }
      const isNew = ignored !== null && step.created && !ignored.has(step.path)
      // A birth time of 0 means the disk does not keep one, and the check is skipped.
      const older = born > 0 && Math.floor(born) <= step.targetAt
      // Rule 7: a new file with the bytes just restored at another path was moved or copied there. Rule 4 held, so its
      // bytes are the safety blob.
      const moved = step.safety !== null && written.has(step.safety)
      if (!isNew || (!moved && (step.updated || older))) {
        kept.set(step.path, "could not tell it is new")
        continue
      }
      const full = join(root, step.path)
      const { reason, now } = check(disk, root, step, keepChanged)
      if (reason) kept.set(step.path, reason)
      else if (now) {
        try {
          if (dry && !changeable(disk, full)) throw new Error("locked")
          if (dry) disk.gone.add(full)
          else unlinkSync(full)
          disk.names.get(dirname(full))?.delete(basename(full).normalize())
          deleted.push(step.path)
        } catch {
          kept.set(step.path, "could not delete it")
        }
      }
    }
  }

  // Rule 6 asks git what is ignored, so the .gitignore files are settled first. Any that did not go back leaves the
  // answer wrong, and then nothing is deleted.
  const ignores = plan.steps.filter((step) => basename(step.path) === ".gitignore")
  const others = plan.steps.filter((step) => basename(step.path) !== ".gitignore")
  await write(ignores)
  await remove(
    ignores,
    ignores.some((step) => step.target !== null && kept.has(step.path)),
  )
  await write(others)
  await remove(
    others,
    ignores.some((step) => kept.has(step.path)),
  )
  for (const { step, bytes, mode } of retry) {
    if (step.target === null || put(disk, root, step, bytes, mode, keepChanged)) continue
    kept.delete(step.path)
    restored.push(step.path)
    written.add(step.target.sha)
  }

  const sorted = [...kept].map(([path, reason]) => ({ path, reason })).toSorted((a, b) => (a.path < b.path ? -1 : 1))
  if (!dry)
    log.info("files restored", { restored: restored.length, deleted: deleted.length, kept: sorted.slice(0, 20) })
  return { restored: restored.toSorted(), deleted: deleted.toSorted(), kept: sorted }
}
