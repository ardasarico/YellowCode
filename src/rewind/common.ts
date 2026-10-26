import { randomBytes } from "node:crypto"
import { closeSync, fchmodSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import { z } from "zod"
import type { Manifest } from "./live-rewind.ts"

// Pieces the rewind's capture, preview, restore and dialog share.

export const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])

export const fileInput = z.looseObject({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
  content: z.string().optional(),
})

// The file an Edit/Write-like call names, with a leading ~ read as HOME.
export function inputFile(input: unknown): string | undefined {
  const parsed = fileInput.safeParse(input).data
  const file = parsed?.file_path ?? parsed?.notebook_path
  return file === undefined ? undefined : expandHome(file)
}

function expandHome(file: string): string {
  if (file === "~") return homedir()
  return file.startsWith("~/") ? join(homedir(), file.slice(2)) : file
}

export function tildePath(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

// A path in `unknown` stands for itself; one ending in "/" for everything under it.
export const covers = (unknown: readonly string[], path: string) =>
  unknown.some((entry) => entry === path || (entry.endsWith("/") && path.startsWith(entry)))

// The blob id git gives these bytes, in the hash `like` is written in (40 hex digits for sha1, 64 for sha256).
export function blobId(bytes: Uint8Array, like: string): string {
  const hasher = new Bun.CryptoHasher(like.length === 64 ? "sha256" : "sha1")
  hasher.update(`blob ${bytes.length}\0`)
  hasher.update(bytes)
  return hasher.digest("hex")
}

// The real path of a file that may not exist yet: its deepest existing folder (or itself) resolved, the rest as given.
function realPath(file: string): string | null {
  let existing = file
  const rest: string[] = []
  while (true) {
    try {
      return join(realpathSync(existing), ...rest)
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return null
      rest.unshift(basename(existing))
      existing = parent
    }
  }
}

// The file's path relative to the snapshots' root, or null outside it. Where the file really is decides, so a
// symlink inside the root that points out leaves the file outside.
export function inRoot(root: string, file: string): string | null {
  if (!isAbsolute(file)) return null
  const path = relative(root, realPath(file) ?? file)
  if (path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) return path.split(sep).join("/")
  return null
}

export function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

// No hook, fsmonitor or submodule status may run from any config the user has.
const SAFE_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.ignoreSubmodules=dirty",
  "-c",
  "core.splitIndex=false",
]

export type GitRun = { code: number; stdout: Uint8Array; stderr: string; timedOut: boolean; killed: string | null }

export function gitEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value
  }
  return { ...env, ...extra }
}

export async function runGit(
  args: string[],
  options: { cwd?: string; env: Record<string, string>; input?: string | Uint8Array; timeoutMs?: number },
): Promise<GitRun> {
  const proc = Bun.spawn(["git", ...SAFE_CONFIG, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          proc.kill()
        }, options.timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  // Exit codes over 128 mean a signal. `killed` names it.
  const killed = !timedOut && (proc.signalCode !== null || code > 128) ? (proc.signalCode ?? String(code)) : null
  return { code, stdout, stderr: stderr.trim(), timedOut, killed }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

export function writeManifest(store: string, manifest: Manifest): void {
  const folder = join(store, "prompts")
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = join(folder, `${manifest.uuid}.json`)
  writeJson(file, manifest)
}

export function writeJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value))
  renameSync(temp, file)
}

// A new file beside `path` holding the bytes, for the caller to rename over it. Throws when it cannot be written.
export function writeBeside(path: string, bytes: Uint8Array, mode: number): string {
  const temp = join(dirname(path), `.${basename(path)}.yc-${randomBytes(4).toString("hex")}`)
  const fd = openSync(temp, "wx", 0o600)
  try {
    writeFileSync(fd, bytes)
    fchmodSync(fd, mode)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  } finally {
    closeSync(fd)
  }
  return temp
}
