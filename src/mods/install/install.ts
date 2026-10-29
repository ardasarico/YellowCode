import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { compatible, incompatibleText, MOD_ID, readManifest } from "../manifest.ts"
import { linkRuntime } from "../runtime.ts"
import { REPO, SHA } from "./list.ts"
import { type InstallRecord, writeRecord } from "./record.ts"
import { dirEntries, hashEntries } from "./tree-hash.ts"

// A mod-local copy of these would shadow the ones linked in by linkRuntime and give the mod a second Solid.
const SHARED = new Set(["solid-js", "@opentui", "yellowcode"])

export type InstallTarget = {
  id: string
  repo: string
  sha: string
  // null for an unlisted mod: nothing to compare with, the computed hash is only recorded.
  treeHash: string | null
  listed: boolean
  // The ref an unlisted mod was added from, kept in the record's source so an update can resolve it again.
  ref?: string
}

export type InstallResult = { ok: true; record: InstallRecord } | { ok: false; problem: string }

// Installs a mod from GitHub at an exact commit into <modsFolder>/<id>. On any failure the mods folder is left as it was.
export async function installAt(target: InstallTarget, modsFolder: string): Promise<InstallResult> {
  const { id, repo, sha } = target
  if (!MOD_ID.test(id)) return { ok: false, problem: `"${id}" is not a mod id` }
  if (!REPO.test(repo)) return { ok: false, problem: `"${repo}" is not owner/repo` }
  if (!SHA.test(sha)) return { ok: false, problem: `"${sha}" is not a full 40-character commit SHA` }

  const created = mkdirSync(modsFolder, { recursive: true })
  // Inside the mods folder, so the final rename never crosses filesystems.
  const temp = join(modsFolder, `.tmp-${id}-${Date.now()}`)
  try {
    const tree = await download(repo, sha, temp, id)
    const { files, symlinks } = dirEntries(tree)
    if (symlinks.length > 0) throw new Error(`the mod has symlinks: ${symlinks.join(", ")}`)
    const treeHash = hashEntries(files)
    if (target.treeHash !== null && treeHash !== target.treeHash)
      throw new Error(`tree hash mismatch: the list has ${target.treeHash}, the download is ${treeHash}`)

    const manifest = readManifest(tree)
    if (!manifest.ok) throw new Error(manifest.problem)
    if (!compatible(manifest.manifest)) throw new Error(incompatibleText(manifest.manifest.api))

    await installDependencies(tree)
    const copies = sharedCopies(tree)
    if (copies.length > 0) throw new Error(`the mod installs its own ${copies.join(", ")}`)

    const record: InstallRecord = {
      source: `github:${repo}${target.ref ? `@${target.ref}` : ""}`,
      sha,
      treeHash,
      version: manifest.manifest.version,
      listed: target.listed,
      installedAt: new Date().toISOString(),
    }
    swapIn(tree, join(modsFolder, id), join(temp, "previous"), () => writeRecord(modsFolder, id, record))
    linkRuntime(modsFolder)
    return { ok: true, record }
  } catch (error) {
    if (created) rmSync(created, { recursive: true, force: true })
    return { ok: false, problem: error instanceof Error ? error.message : String(error) }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

async function download(repo: string, sha: string, temp: string, id: string): Promise<string> {
  const base = process.env["YELLOWCODE_CODELOAD"] ?? "https://codeload.github.com"
  const response = await fetch(`${base}/${repo}/tar.gz/${sha}`, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
  const extracted = join(temp, "extracted")
  await new Bun.Archive(await response.bytes()).extract(extracted)
  const top = readdirSync(extracted)
  if (top.length !== 1 || !statSync(join(extracted, top[0]!)).isDirectory())
    throw new Error("the download is not a single folder")
  // Named after the id, since readManifest checks the manifest's id against the folder name.
  const tree = join(temp, id)
  renameSync(join(extracted, top[0]!), tree)
  return tree
}

async function installDependencies(tree: string): Promise<void> {
  if (!existsSync(join(tree, "package.json"))) return
  if (!existsSync(join(tree, "bun.lock"))) throw new Error("the mod has a package.json but no bun.lock")
  const install = Bun.spawn(
    [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--production",
      "--ignore-scripts",
      "--omit=peer",
      "--config=/dev/null",
    ],
    { cwd: tree, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  )
  const [code, stderr] = await Promise.all([install.exited, new Response(install.stderr).text()])
  if (code !== 0) throw new Error(`bun install failed: ${stderr.trim().split("\n").at(-1) ?? ""}`)
}

// Walks all of node_modules, the .bun store included, since a nested copy resolves just the same.
function sharedCopies(tree: string): string[] {
  const found: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = `${rel}/${item.name}`
      if (SHARED.has(item.name)) found.push(path)
      else if (item.isDirectory()) walk(join(dir, item.name), path)
    }
  }
  if (existsSync(join(tree, "node_modules"))) walk(join(tree, "node_modules"), "node_modules")
  return found
}

function swapIn(tree: string, target: string, previous: string, finish: () => void): void {
  const had = existsSync(target)
  if (had) renameSync(target, previous)
  let moved = false
  try {
    renameSync(tree, target)
    moved = true
    finish()
  } catch (error) {
    if (moved) renameSync(target, tree)
    if (had) renameSync(previous, target)
    throw error
  }
}
