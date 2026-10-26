import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { join, relative } from "node:path"
import { log } from "../log/log.ts"
import type { RewindExtras, RewindPreview } from "../session/rewind.ts"
import type { Session } from "../session/types.ts"
import { blobId, covers, fileInput, inRoot, tildePath } from "./common.ts"
import { agentWrites, type Capture, type Manifest, type Point, promptManifests, type Segment } from "./live-rewind.ts"
import { type OutsideFile, outsideNow, refsUnder, restoreOutside } from "./outside.ts"
import { applyRestore, createdIn, planRestore, type RestoreInput, type Target } from "./restore.ts"
import type { Snapshots, Taken, TreeEntry } from "./snapshots.ts"

const BLOB_MODES = new Set(["100644", "100755", "120000"])

const blobOf = (entry: TreeEntry | undefined) => (entry && BLOB_MODES.has(entry.mode) ? entry.sha : null)

const tracked = (manifest: Manifest | null) =>
  manifest !== null &&
  manifest.segments.every((segment) => segment.before && (segment.after || segment.kind === "imported"))

const imported = (manifest: Manifest | null) => manifest?.segments.some((segment) => segment.kind === "imported")

// An agent segment's after already holds an edit made while the agent ran, so the agent's own last call is the
// reference: a Write must have left its content; an Edit cannot be checked without the file it started from.
function agentChanged(session: Session, callId: string | undefined, after: string | null): boolean {
  const call = callId === undefined ? undefined : session.byId[callId]
  if (call?.kind !== "tool" || call.name !== "Write") return true
  const content = fileInput.safeParse(call.input).data?.content
  return content === undefined || after === null || blobId(Buffer.from(content), after) !== after
}

// What a rewind to the prompt restores, as Enter and the dialog's dry run both build it; the safety snapshot is added
// by the caller, and stands in for `after` when only imported segments are undone. Null when the prompt has no full
// snapshots, or it or a later prompt has no manifest.
export async function restoreInput(
  snapshots: Snapshots,
  manifests: (Manifest | null)[],
  prompt: number,
): Promise<(Omit<RestoreInput, "safety" | "after"> & { target: Target; after: Point | null }) | null> {
  const undone = manifests.slice(prompt)
  if (undone.includes(null)) return null
  const first = manifests[prompt]?.segments[0]
  const segments = undone.flatMap((later) => later?.segments ?? [])
  const after = segments.findLast((segment) => segment.after)?.after ?? null
  if (!first?.before || (!after && first.kind !== "imported")) return null
  const input = {
    snapshots,
    targetAt: first.beforeAt,
    after,
    paths: segments.flatMap((segment) => segment.changes.map((change) => change.path)),
    created: createdIn(segments.map((segment) => segment.changes)),
    writes: segments.flatMap((segment) => segment.writes),
  }
  if (!segments.some((segment) => segment.kind === "imported")) return { ...input, target: first.before }
  return { ...input, ...(await mixedTarget(snapshots, segments)) }
}

// With imported segments among the undone ones, each path goes back to the before of the first segment that changed
// it: an imported segment's backups, or the before of the first live segment, as a rewind of live prompts alone does.
async function mixedTarget(snapshots: Snapshots, segments: Segment[]) {
  const live = segments.find((segment) => segment.kind !== "imported")
  const firstOf = new Map<string, Segment>()
  for (const segment of segments)
    for (const { path } of segment.changes)
      if (!firstOf.has(path)) firstOf.set(path, segment.kind === "imported" || !live ? segment : live)
  const files = new Map<string, TreeEntry | null>()
  const targetAts = new Map<string, number>()
  for (const [from, paths] of Map.groupBy(firstOf.keys(), (path) => firstOf.get(path))) {
    const before = from?.before
    if (!before) continue
    // oxlint-disable-next-line no-await-in-loop -- one per segment
    const entries = await snapshots.entries(before.tree, paths)
    for (const path of paths) {
      targetAts.set(path, from.beforeAt)
      // A path the before could not read is left out of the map, so the restore keeps it.
      if (!covers(before.unknown, path)) files.set(path, entries.get(path) ?? null)
    }
  }
  return { target: { files }, targetAts }
}

// What earlier rewinds since the last send changed: the snapshot after the latest, the paths they restored, and the
// files outside the root they changed, with what each holds now (`after`).
export type Pending = { after: Point | null; paths: ReadonlySet<string>; outside: ReadonlyMap<string, OutsideFile> }

// The files outside the root the prompts from `prompt` on changed: each goes back to what it held before the first
// of them, over what the last one left, or what an earlier rewind left. `kept` are the ones that cannot go back.
export function outsideFiles(
  manifests: (Manifest | null)[],
  prompt: number,
  pending: Pending | null,
): { files: OutsideFile[]; kept: string[] } {
  const segments = manifests.slice(prompt).flatMap((later) => later?.segments ?? [])
  const kept = new Set(segments.flatMap((segment) => segment.outsideKept))
  const files = new Map<string, OutsideFile>()
  for (const segment of segments)
    for (const file of segment.outside) {
      const first = files.get(file.path)
      const after = pending?.outside.get(file.path)?.after
      files.set(file.path, {
        path: file.path,
        before: first ? first.before : file.before,
        after: after === undefined ? file.after : after,
      })
    }
  return { files: [...files.values()].filter((file) => !kept.has(file.path)), kept: [...kept] }
}

// As the chat names files: relative to the session's folder when inside it, else the full path.
export function chatPaths(root: string, cwd: string): (path: string) => string {
  let base = cwd
  try {
    base = realpathSync(cwd)
  } catch {}
  return (path) => {
    const full = join(root, path)
    const inside = relative(base, full)
    return inside === ".." || inside.startsWith("../") ? full : inside
  }
}

// What a rewind to the prompt would restore and delete now: the restore run dry, from the same input a rewind builds,
// with a snapshot taken now as its safety snapshot. Null when the prompt has no full snapshots; a failure rejects, so
// the dialog can say the files were not checked.
async function dryRun(
  snapshots: Snapshots,
  manifests: (Manifest | null)[],
  safety: Taken,
  prompt: number,
): Promise<string[] | null> {
  const input = await restoreInput(snapshots, manifests, prompt)
  if (!input) return null
  const plan = await planRestore({ ...input, safety, after: input.after ?? safety })
  const result = await applyRestore(plan, { dryRun: true })
  log.debug("rewind dry run", { prompt, ...result })
  return [...result.restored, ...result.deleted]
}

// Paths a user (or anyone) changed after the last segment that changed them, or after an earlier rewind put them
// back, as the snapshot `safety` holds them now.
export async function conflictsNow(
  snapshots: Snapshots,
  session: Session,
  manifests: (Manifest | null)[],
  safety: Taken,
  pending: Pending | null,
): Promise<string[]> {
  const conflicts: string[] = []
  // The last segment that changed each path, with its prompt.
  const latest = new Map<string, { segment: Segment; prompt: number }>()
  for (const [prompt, manifest] of manifests.entries())
    for (const segment of manifest?.segments ?? [])
      for (const change of segment.changes) latest.set(change.path, { segment, prompt })
  const paths = [...latest.keys()]
  const now = await snapshots.entries(safety.tree, paths)
  const expected = new Map<string, TreeEntry>()
  const byAfter = Map.groupBy(paths, (path) => latest.get(path)?.segment.after?.tree ?? "")
  byAfter.delete("")
  const read = [...byAfter].map(([tree, group]) => snapshots.entries(tree, group))
  for (const entries of await Promise.all(read)) for (const [path, entry] of entries) expected.set(path, entry)
  // The last Edit/Write call an agent made to each path, by prompt.
  const agentCalls = new Map<string, string>()
  for (const call of agentWrites(session)) {
    const path = inRoot(snapshots.root, call.write.file)
    if (path !== null) agentCalls.set(`${call.uuid}\0${path}`, call.id)
  }
  // A path an earlier rewind restored is measured against what that rewind left.
  const rewound = pending?.after ? await snapshots.entries(pending.after.tree, [...pending.paths]) : null
  for (const path of paths) {
    if (rewound && pending?.paths.has(path)) {
      if (!covers(safety.unknown, path) && blobOf(now.get(path)) !== blobOf(rewound.get(path))) conflicts.push(path)
      continue
    }
    const found = latest.get(path)
    // Claude's backups have no after: what its last call left stands in, and a path where that is unknown is ⚠.
    if (found?.segment.kind === "imported") {
      const left = found.segment.left?.[path]
      if (!covers(safety.unknown, path) && (left === undefined || blobOf(now.get(path)) !== left)) conflicts.push(path)
      continue
    }
    const entry = expected.get(path)
    if (!found?.segment.after || covers(safety.unknown, path) || (entry && !BLOB_MODES.has(entry.mode))) continue
    const after = blobOf(entry)
    const uuid = manifests[found.prompt]?.uuid
    const agent = found.segment.kind === "agent" && agentChanged(session, agentCalls.get(`${uuid}\0${path}`), after)
    if (blobOf(now.get(path)) !== after || agent) conflicts.push(path)
  }

  return conflicts
}

async function preview(
  snapshots: Snapshots,
  session: Session,
  cwd: string,
  selected: number,
  pending: Pending | null,
): Promise<RewindExtras> {
  const prompts = session.items.flatMap((id) => {
    const item = session.byId[id]
    return item?.kind === "user" ? [item] : []
  })
  const manifests = promptManifests(snapshots.store, prompts)
  const shown = chatPaths(snapshots.root, cwd)

  const extras: RewindExtras = {
    bash: [],
    conflicts: [],
    untracked: [],
    imported: [],
    shells: [],
    restores: [],
    outside: [],
  }
  for (const [prompt, manifest] of manifests.entries()) {
    if (!tracked(manifest)) extras.untracked.push(prompt)
    if (imported(manifest)) extras.imported.push(prompt)
    if (!manifest) continue
    if (manifest.shells.length > 0) extras.shells.push({ prompt, names: manifest.shells })
    const written = new Set(manifest.segments.flatMap((segment) => segment.writes.map((write) => write.path)))
    for (const segment of manifest.segments) {
      for (const change of segment.changes) {
        if (!written.has(change.path))
          extras.bash.push({
            prompt,
            path: shown(change.path),
            plus: change.plus ?? 0,
            minus: change.minus ?? 0,
            // An imported path no call in the chat names was changed by a subagent's Edit/Write.
            edit: segment.kind === "imported",
          })
      }
    }
  }

  // A quit in the middle of an earlier preview leaves its ref behind.
  const left = await refsUnder(snapshots.store, "refs/yc/preview-")
  await Promise.all(left.map((ref) => snapshots.drop(ref.slice("refs/yc/".length))))
  const id = `preview-${randomUUID()}`
  const safety = await snapshots.take(id)
  // The tree stays in the store without the ref, and nothing prunes it while the dialog is open.
  await snapshots.drop(id)
  if (!safety) return extras
  for (const path of await conflictsNow(snapshots, session, manifests, safety, pending))
    extras.conflicts.push(shown(path))

  await outside(snapshots, manifests, extras, pending)
  // Each prompt's dry run, once; the dialog asks for the others while it is open.
  const runs = new Map<number, Promise<string[] | null>>()
  extras.dryRun = (prompt) => {
    let run = runs.get(prompt)
    if (!run) {
      run = dryRun(snapshots, manifests, safety, prompt).then(async (found) => {
        if (!found) return null
        const outsideDry = outsideFiles(manifests, prompt, pending).files
        const files = await restoreOutside(snapshots.store, outsideDry, { dryRun: true })
        return [...found.map(shown), ...files.restored, ...files.deleted]
      })
      runs.set(prompt, run)
    }
    return run
  }
  // A failed one is left for the dialog, which asks again and says so.
  const first = await extras.dryRun(selected).catch(() => null)
  if (first) extras.restores.push({ prompt: selected, paths: first })
  return extras
}

// Outside the project a file goes back only from what the capture kept of it, and only over what Claude left there.
// The ones that stay are listed by prompt.
async function outside(
  snapshots: Snapshots,
  manifests: (Manifest | null)[],
  extras: RewindExtras,
  pending: Pending | null,
) {
  const lastAfter = new Map<string, string | null>()
  for (const manifest of manifests)
    for (const segment of manifest?.segments ?? [])
      for (const file of segment.outside) lastAfter.set(file.path, file.after)
  for (const [path, file] of pending?.outside ?? []) lastAfter.set(path, file.after)
  const hashed = [...lastAfter.keys()].map(async (path) => [path, await outsideNow(snapshots.store, path)] as const)
  const now = new Map(await Promise.all(hashed))
  for (const [prompt, manifest] of manifests.entries())
    for (const segment of manifest?.segments ?? []) {
      for (const path of segment.outsideKept) extras.outside.push({ prompt, path: tildePath(path) })
      for (const { path } of segment.outside) {
        const found = now.get(path)
        if (found === undefined || found !== lastAfter.get(path)) extras.outside.push({ prompt, path: tildePath(path) })
      }
    }
}

// What the snapshots say about each prompt of the session, once the open agent segments are closed.
export function livePreview(
  capture: Capture | null,
  cwd: string,
  pending: (session: Session) => Pending | null = () => null,
): RewindPreview {
  return async (session, selected) => {
    const snapshots = await capture?.snapshots
    if (!capture || !snapshots) {
      const untracked = session.items.filter((id) => session.byId[id]?.kind === "user").map((_, at) => at)
      return { bash: [], conflicts: [], untracked, imported: [], shells: [], restores: [], outside: [] }
    }
    await capture.settle()
    return preview(snapshots, session, session.info?.cwd || cwd, selected, pending(session))
  }
}
