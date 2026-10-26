import { lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import { getSettingsRequest } from "../protocol/outgoing.ts"
import type { Requests } from "../source/requests.ts"
import { alive, gitEnv, runGit } from "./common.ts"
import { type Manifest, readManifest } from "./live-rewind.ts"
import type { Snapshots } from "./snapshots.ts"

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_CLEANUP_DAYS = 30
const WARM_UP_REF = "refs/yc/warm-up"
// Objects written before their ref exists (a take, keepBytes, another process just starting) outlive the prune.
const PRUNE_EXPIRE = "1.hour.ago"

const settingsReply = z.looseObject({
  effective: z.looseObject({ cleanupPeriodDays: z.unknown().optional() }).optional(),
})

// What rewind-files writes for a pending /redo.
const rewindRecord = z.looseObject({ pid: z.number(), refs: z.array(z.string()), blobs: z.array(z.string()) })

export type Pruned = { manifests: number; refs: number; gc: "done" | "failed" | "skipped" }

// Prunes the store once claude says how long it keeps sessions. Never throws, so the start never waits on it.
export async function pruneAtStart(snapshots: Promise<Snapshots | null>, requests: Requests): Promise<void> {
  try {
    const store = await snapshots
    if (!store) return
    // Without the reply the user's own period is unknown, and a guess could remove snapshots they keep.
    const days = cleanupDays(await requests.send(getSettingsRequest))
    await pruneStore(store, days)
  } catch (error) {
    log.warn("snapshots not pruned", String(error))
  }
}

function cleanupDays(reply: unknown): number {
  const days = settingsReply.safeParse(reply).data?.effective?.cleanupPeriodDays
  return typeof days === "number" && days > 0 ? days : DEFAULT_CLEANUP_DAYS
}

// Null when the store was pruned less than a day ago.
export async function pruneStore(snapshots: Snapshots, days: number, now = Date.now()): Promise<Pruned | null> {
  const { store } = snapshots
  const gitDir = join(store, "git")
  const stamp = join(store, "pruned-at")
  const last = Number(readText(stamp))
  if (Number.isFinite(last) && now - last < DAY_MS) return null
  writeFileSync(stamp, String(now))
  const sizeBefore = sizeOf(gitDir)

  const cutoff = now - days * DAY_MS
  const keptRefs = new Set<string>()
  const oldRefs = new Set<string>()
  let manifests = 0
  // A recent manifest this version cannot read still names refs, so no stray is safe to remove.
  let unreadRecent = false
  const folder = join(store, "prompts")
  for (const name of listDir(folder)) {
    if (!name.endsWith(".json")) continue
    const file = join(folder, name)
    const manifest = readManifest(store, name.slice(0, -".json".length))
    const sentAt = manifest?.sentAt ?? lstatSync(file, { throwIfNoEntry: false })?.mtimeMs ?? now
    if (sentAt >= cutoff) {
      if (manifest) for (const ref of refsOf(manifest)) keptRefs.add(ref)
      else unreadRecent = true
      continue
    }
    if (manifest) for (const ref of refsOf(manifest)) oldRefs.add(ref)
    rmSync(file, { force: true })
    manifests++
  }

  // A pending /redo of a running process needs its snapshots, which no manifest names.
  const records = join(store, "rewinds")
  for (const name of listDir(records)) {
    if (!name.endsWith(".json")) continue
    const file = join(records, name)
    const json = parseJson(readText(file))
    const record = json.ok ? rewindRecord.safeParse(json.value).data : undefined
    if (!record) {
      unreadRecent = true
      continue
    }
    if (!alive(record.pid)) {
      rmSync(file, { force: true })
      continue
    }
    for (const id of record.refs) keptRefs.add(`refs/yc/${id}`)
    for (const blob of record.blobs) keptRefs.add(`refs/yc-outside/${blob}`)
  }

  // Refs of a process still running may not be in a manifest yet, so strays are swept only when none is.
  const othersAlive = othersUsing(store)
  const remove = (await refs(gitDir)).filter((ref) => {
    if (keptRefs.has(ref) || ref === WARM_UP_REF) return false
    if (oldRefs.has(ref)) return true
    return !othersAlive && !unreadRecent && now - refTime(gitDir, ref, now) > DAY_MS
  })
  if (remove.length > 0) {
    const input = remove.map((ref) => `delete ${ref}\n`).join("")
    const deleted = await git(gitDir, ["update-ref", "--stdin"], input)
    if (deleted.code !== 0) throw new Error(`git update-ref failed: ${deleted.stderr}`)
  }

  let gc: Pruned["gc"] = "skipped"
  if (!othersAlive) {
    // Without the project's objects as alternates: with them, prune removes the store's own copy of a blob the
    // project's pack also holds. Loose objects only, so packs of unreachable trees stay behind.
    const run = await git(gitDir, ["prune", `--expire=${PRUNE_EXPIRE}`])
    gc = run.code === 0 ? "done" : "failed"
    if (run.code !== 0) log.warn("snapshot prune failed, pruned refs only", run.stderr.trim())
  }

  const pruned = { manifests, refs: remove.length, gc }
  log.info("snapshots pruned", { store, days, ...pruned, sizeBefore, sizeAfter: sizeOf(gitDir) })
  return pruned
}

function refsOf(manifest: Manifest): string[] {
  const found: string[] = []
  for (const segment of manifest.segments) {
    for (const point of [segment.before, segment.after, segment.base?.before])
      if (point) found.push(`refs/yc/${point.id}`)
    for (const file of segment.outside) if (file.before) found.push(`refs/yc-outside/${file.before}`)
  }
  return found
}

async function refs(gitDir: string): Promise<string[]> {
  const listed = await git(gitDir, ["for-each-ref", "--format=%(refname)", "refs/yc/", "refs/yc-outside/"])
  if (listed.code !== 0) throw new Error(`git for-each-ref failed: ${listed.stderr}`)
  return listed.stdout.split("\n").filter(Boolean)
}

// A packed ref has no file of its own; packed-refs is at least as new as it. A ref with neither (reftable) counts as
// new, so it is never swept as a stray.
function refTime(gitDir: string, ref: string, now: number): number {
  const stat =
    lstatSync(join(gitDir, ref), { throwIfNoEntry: false }) ??
    lstatSync(join(gitDir, "packed-refs"), { throwIfNoEntry: false })
  return stat?.mtimeMs ?? now
}

function othersUsing(store: string): boolean {
  return listDir(store).some((name) => {
    const pid = Number(/^index-(\d+)$/.exec(name)?.[1])
    return Number.isInteger(pid) && pid !== process.pid && alive(pid)
  })
}

async function git(
  gitDir: string,
  args: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const run = await runGit(args, { env: gitEnv({ GIT_DIR: gitDir }), input })
  return { code: run.code, stdout: new TextDecoder().decode(run.stdout), stderr: run.stderr }
}

function sizeOf(dir: string): number {
  let total = 0
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" }))
    total += lstatSync(join(dir, name), { throwIfNoEntry: false })?.size ?? 0
  return total
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}
