import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs"
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

export function expandHome(file: string): string {
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
export function realPath(file: string): string | null {
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

export function writeManifest(store: string, manifest: Manifest): void {
  const folder = join(store, "prompts")
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const file = join(folder, `${manifest.uuid}.json`)
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(manifest))
  renameSync(temp, file)
}
