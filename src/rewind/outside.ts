/* oxlint-disable no-await-in-loop */
import { randomBytes } from "node:crypto"
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import { log } from "../log/log.ts"
import { gitEnv, runGit } from "./common.ts"

// Files outside the snapshots' root: what a main-thread Edit/Write said the file held before goes into the store as a
// blob of its own, and only the file's hash is taken afterwards.

async function git(store: string, args: string[], input?: Uint8Array): Promise<string | null> {
  const run = await runGit(args, { env: gitEnv({ GIT_DIR: join(store, "git") }), input })
  if (run.code === 0) return new TextDecoder().decode(run.stdout).trim()
  log.warn("git failed", { args: args.slice(0, 2), error: run.stderr })
  return null
}

// The bytes as a blob in the store, under a ref of its own so pruning finds it with the manifest that names it.
export async function keepBytes(store: string, bytes: Uint8Array): Promise<string | null> {
  const sha = await git(store, ["hash-object", "-w", "--no-filters", "--stdin"], bytes)
  if (!sha) return null
  return (await git(store, ["update-ref", `refs/yc-outside/${sha}`, sha])) === null ? null : sha
}

// The blob sha the file has now: null when nothing is there, undefined when it is no regular file or cannot be read.
export async function fileHash(store: string, file: string): Promise<string | null | undefined> {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(file, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
  if (!stat) return null
  if (!stat.isFile()) return undefined
  return (await git(store, ["hash-object", "--no-filters", "--", file])) ?? undefined
}

// The store's refs whose names start with the prefix.
export async function refsUnder(store: string, prefix: string): Promise<string[]> {
  const listed = await git(store, ["for-each-ref", "--format=%(refname)"])
  return (listed ?? "").split("\n").filter((ref) => ref.startsWith(prefix))
}

async function blobBytes(store: string, sha: string): Promise<Uint8Array | null> {
  const run = await runGit(["cat-file", "blob", sha], { env: gitEnv({ GIT_DIR: join(store, "git") }) })
  return run.code === 0 ? run.stdout : null
}

// A file outside the root as a rewind sees it: `before` is the blob it goes back to (null: no file), `after` the hash
// it must have now (null: no file), or it is kept. `mode` is the one a file brought back gets.
export type OutsideFile = { path: string; before: string | null; after: string | null; mode?: number }
// `undo` holds, for each file changed, what /redo needs to change it back.
export type OutsideResult = { restored: string[]; deleted: string[]; kept: string[]; undo: OutsideFile[] }

// Every folder above the file is a real folder, none a symlink.
function plainFolders(file: string): boolean {
  if (!isAbsolute(file) || file.split("/").some((part) => part === "." || part === "..")) return false
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const stat = lstatSync(dir, { throwIfNoEntry: false })
    if (!stat?.isDirectory()) return false
    if (dirname(dir) === dir) return true
  }
}

// The file's hash when a rewind may change it: a regular file, or none, in plain folders. Undefined otherwise.
export async function outsideNow(store: string, file: string): Promise<string | null | undefined> {
  try {
    return plainFolders(file) ? await fileHash(store, file) : undefined
  } catch {
    return undefined
  }
}

// Puts each file back to `before` only while it still is exactly `after`, writing beside it and renaming over it; a
// file goes away only when `before` says there was none. With `keep`, what the file holds is stored first, so the
// change can be undone. A dry run checks the same and changes nothing.
export async function restoreOutside(
  store: string,
  files: readonly OutsideFile[],
  options: { dryRun?: boolean; keep?: boolean } = {},
): Promise<OutsideResult> {
  const result: OutsideResult = { restored: [], deleted: [], kept: [], undo: [] }
  for (const file of files) {
    const now = await outsideNow(store, file.path)
    if (now === undefined || now !== file.after) {
      result.kept.push(file.path)
      continue
    }
    if (now === file.before) continue
    const done = options.dryRun ? writable(file.path) : await change(store, file, options.keep === true)
    if (done === false) {
      result.kept.push(file.path)
      continue
    }
    if (file.before === null) result.deleted.push(file.path)
    else result.restored.push(file.path)
    if (done !== true) result.undo.push(done)
  }
  if (!options.dryRun && files.length > 0)
    log.info("outside files restored", {
      restored: result.restored.length,
      deleted: result.deleted.length,
      kept: result.kept.length,
    })
  return result
}

function writable(file: string): boolean {
  try {
    accessSync(dirname(file), constants.W_OK)
    return true
  } catch {
    return false
  }
}

// False when the file stays as it is; otherwise the undo entry (true when none was asked for).
async function change(store: string, file: OutsideFile, keep: boolean): Promise<OutsideFile | boolean> {
  let undo: OutsideFile | true = true
  if (keep) {
    let was: string | null = null
    if (file.after !== null) {
      try {
        was = await keepBytes(store, readFileSync(file.path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }))
      } catch {
        return false
      }
      if (was !== file.after) return false
    }
    undo = {
      path: file.path,
      before: was,
      after: file.before,
      mode: lstatSync(file.path, { throwIfNoEntry: false })?.mode,
    }
  }
  if (file.before === null) {
    if ((await outsideNow(store, file.path)) !== file.after) return false
    try {
      unlinkSync(file.path)
      return undo
    } catch {
      return false
    }
  }
  const bytes = await blobBytes(store, file.before)
  if (!bytes) return false
  const temp = join(dirname(file.path), `.${basename(file.path)}.yc-${randomBytes(4).toString("hex")}`)
  const mode = lstatSync(file.path, { throwIfNoEntry: false })?.mode ?? file.mode
  // Checked before the temp file exists: from there to the rename nothing waits, so a quit cannot leave it behind.
  if ((await outsideNow(store, file.path)) !== file.after) return false
  let made = false
  try {
    const fd = openSync(temp, "wx", 0o600)
    made = true
    try {
      writeFileSync(fd, bytes)
      fchmodSync(fd, mode === undefined ? 0o644 : mode & 0o777)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file.path)
    return undo
  } catch {
    if (made) rmSync(temp, { force: true })
    return false
  }
}
