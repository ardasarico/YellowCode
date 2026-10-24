import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { log } from "../log/log.ts"
import type { ItemId, Session } from "../session/types.ts"
import { covers, tildePath } from "./common.ts"
import { type Capture, type Point, readManifest } from "./live-rewind.ts"
import { type OutsideFile, restoreOutside } from "./outside.ts"
import { chatPaths, conflictsNow, outsideFiles, type Pending, restoreInput } from "./preview.ts"
import { applyRestore, createdIn, planRestore, type RestoreResult } from "./restore.ts"
import type { Snapshots, Taken, TreeEntry } from "./snapshots.ts"

// `paths` are what changed, as the chat names them; `kept` what stayed as it was although a rewind would change it.
// "changed": the files changed since the dialog showed its ⚠, which now lists more; nothing was written.
// `which` says whether a rewind's own prompt or a later one was not tracked.
export type FilesOutcome =
  | { kind: "untracked"; which?: "this" | "later" }
  | { kind: "failed"; reason: string }
  | { kind: "changed"; conflicts: string[]; paths: string[] }
  | { kind: "done"; paths: string[]; kept: string[] }

export type FileRewind = {
  // Enter: puts back the files the prompts from `userId` on changed. Nothing is touched unless it is "done". `seen`
  // are the ⚠ paths the dialog showed, as the chat names them.
  rewind(session: Session, userId: ItemId, seen: ReadonlySet<string>): Promise<FilesOutcome>
  // /redo: brings back what the rewinds since the last send changed; "untracked" when they changed nothing.
  redo(session: Session): Promise<FilesOutcome>
  // The rewinds are final (the next send, another session): their snapshots go.
  release(): void
  // At quit: released, and no rewind still running writes a record any more.
  stop(): void
  // Why a rewind of the session's files cannot start now, before anything else is done for it; null when it can.
  refused(session: Session): string | null
  // What the session's rewinds since the last send changed, for the next preview.
  pending(session: Session): Pending | null
}

type Held = { point: Promise<Point | null>; taken: Point; at: number }

// One rewind since the last send: R, taken just before it, and R_after, null when that take failed.
type Done = { safety: Held; after: Held | null }

// What /redo needs. Each path goes back to its bytes in the R of the rewind `source` names (the first one unless
// something changed the path between two rewinds), over what the latest R_after holds.
type Rewinds = {
  id: string
  session: Session
  done: Done[]
  paths: Set<string>
  source: Map<string, number>
  outside: Map<string, OutsideFile>
}

const prompts = (session: Session) =>
  session.items.flatMap((id) => {
    const item = session.byId[id]
    return item?.kind === "user" ? [item] : []
  })

const lastAfter = (state: Rewinds) => state.done.findLast((one) => one.after)?.after ?? null

// Paths a nested repository or an unreadable folder made since the target, which no change names and no restore
// touches.
async function unknownLeft(snapshots: Snapshots, target: Taken, after: Taken, listed: Set<string>) {
  const fresh = after.unknown.filter((path) => !covers(target.unknown, path) && !listed.has(path))
  const inTarget = await snapshots.entries(
    target.tree,
    fresh.map((path) => path.replace(/\/$/, "")),
  )
  return fresh.filter((path) => !inTarget.has(path.replace(/\/$/, "")))
}

export function createFileRewind(capture: Capture | null, cwd: string): FileRewind {
  let rewinds: Rewinds | null = null
  let stopped = false

  const recordFile = (snapshots: Snapshots, state: Rewinds) => join(snapshots.store, "rewinds", `${state.id}.json`)

  // Names the snapshots and stored blobs a pending /redo needs, so pruning leaves them alone until release().
  const writeRecord = (snapshots: Snapshots, state: Rewinds) => {
    if (stopped) return
    try {
      mkdirSync(join(snapshots.store, "rewinds"), { recursive: true, mode: 0o700 })
      const file = recordFile(snapshots, state)
      const record = {
        id: state.id,
        pid: process.pid,
        sessionId: state.session.info?.id ?? null,
        createdAt: state.done[0]?.safety.at ?? Date.now(),
        refs: state.done.flatMap((one) => [one.safety.taken.id, ...(one.after ? [one.after.taken.id] : [])]),
        blobs: [...state.outside.values()].flatMap((entry) => (entry.before ? [entry.before] : [])),
      }
      writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(record))
      renameSync(`${file}.${process.pid}.tmp`, file)
    } catch (error) {
      log.warn("rewind record not written", String(error))
    }
  }

  const release = () => {
    const state = rewinds
    if (!state || !capture) return
    rewinds = null
    for (const one of state.done) {
      capture.release(one.safety.point)
      if (one.after) capture.release(one.after.point)
    }
    void capture.snapshots.then((snapshots) => {
      if (snapshots) rmSync(recordFile(snapshots, state), { force: true })
    })
  }

  const hold = async (): Promise<Held | null> => {
    if (!capture || stopped) return null
    const at = Date.now()
    const point = capture.snapshot()
    const taken = await point.catch(() => null)
    return taken ? { point, taken, at } : null
  }

  const pending = (session: Session): Pending | null => {
    if (!rewinds || rewinds.session !== session) return null
    return { after: lastAfter(rewinds)?.taken ?? null, paths: rewinds.paths, outside: rewinds.outside }
  }

  // The rewind's R is the target of every path new to the rewinds, and of every path changed since the rewind before
  // it (`between`).
  const addRewind = (state: Rewinds, safety: Held, after: Held | null, paths: readonly string[], between: string[]) => {
    const fresh = paths.filter((path) => !state.paths.has(path))
    const index = state.done.length
    state.done.push({ safety, after })
    for (const path of paths) state.paths.add(path)
    for (const path of fresh) if (!state.source.has(path)) state.source.set(path, index)
    for (const path of between) if (state.paths.has(path)) state.source.set(path, index)
  }

  // Without its R_after, /redo could not tell the user's edits since the last rewind from what that rewind left.
  const refused = (session: Session) =>
    rewinds?.session === session && rewinds.done.at(-1)?.after === null
      ? "the last rewind left no snapshot; /redo or send first"
      : null

  return {
    release,
    pending,
    refused,

    // A rewind still running takes no snapshot and writes no record after this.
    stop() {
      stopped = true
      release()
    },

    async rewind(session, userId, seen) {
      const snapshots = await capture?.snapshots
      if (!capture || !snapshots) return { kind: "untracked", which: "this" }
      if (rewinds && rewinds.session !== session) release()
      await capture.settle()
      const all = prompts(session)
      const at = all.findIndex((item) => item.id === userId)
      const manifests = all.map((item) => (item.uuid ? readManifest(snapshots.store, item.uuid) : null))
      const input = await restoreInput(snapshots, manifests, at).catch((error: unknown) => {
        log.warn("rewind input not read", String(error))
        return undefined
      })
      if (input === undefined) return { kind: "failed", reason: "could not read the snapshots" }
      if (at === -1 || !input) {
        const later = manifests[at]?.segments[0]?.before && manifests.slice(at + 1).includes(null)
        return { kind: "untracked", which: later ? "later" : "this" }
      }
      const reason = refused(session)
      if (reason) return { kind: "failed", reason }
      const previous = rewinds?.done.at(-1)

      const safety = await hold()
      if (!safety) return { kind: "failed", reason: "could not take a snapshot" }
      const shown = chatPaths(snapshots.root, session.info?.cwd || cwd)
      const known = pending(session)
      const outside = outsideFiles(manifests, at, known)
      let result: RestoreResult
      let between: string[] = []
      try {
        if (previous?.after)
          between = (await snapshots.changes(previous.after.taken.tree, safety.taken.tree)).map((change) => change.path)
        const plan = await planRestore({ ...input, safety: safety.taken, after: input.after ?? safety.taken })
        // What the dialog showed may be out of date: a file changed after it opened is a new ⚠ first.
        const dry = await applyRestore(plan, { dryRun: true })
        const touched = new Set([...dry.restored, ...dry.deleted])
        const conflicts = (await conflictsNow(snapshots, session, manifests, safety.taken, known))
          .filter((path) => touched.has(path))
          .map(shown)
        if (conflicts.some((path) => !seen.has(path))) {
          capture.release(safety.point)
          const outsideDry = await restoreOutside(snapshots.store, outside.files, { dryRun: true })
          return {
            kind: "changed",
            conflicts,
            paths: [...[...touched].map(shown), ...outsideDry.restored, ...outsideDry.deleted],
          }
        }
        result = await applyRestore(plan)
      } catch (error) {
        log.warn("rewind restore failed", String(error))
        capture.release(safety.point)
        return { kind: "failed", reason: "could not read the snapshots" }
      }
      const state: Rewinds = rewinds ?? {
        id: randomUUID(),
        session,
        done: [],
        paths: new Set(),
        source: new Map(),
        outside: new Map(),
      }
      rewinds = state
      const moved = await restoreOutside(snapshots.store, outside.files, { keep: true })
      for (const file of moved.undo) {
        const earlier = state.outside.get(file.path)
        state.outside.set(file.path, earlier ? { ...file, before: earlier.before, mode: earlier.mode } : file)
      }
      const after = await hold()
      addRewind(state, safety, after, input.paths, between)
      if (rewinds === state) writeRecord(snapshots, state)

      const listed = new Set(result.kept.map((file) => file.path))
      const { target } = input
      const left =
        "tree" in target && input.after
          ? await unknownLeft(snapshots, target, input.after, listed).catch((error: unknown) => {
              log.warn("unknown paths not read", String(error))
              return []
            })
          : []
      return {
        kind: "done",
        paths: [...[...result.restored, ...result.deleted].map(shown), ...moved.restored, ...moved.deleted],
        kept: [
          ...result.kept.map((file) => shown(file.path)),
          ...left.map((path) => (path.endsWith("/") ? `${shown(path.slice(0, -1))}/` : shown(path))),
          ...[...moved.kept, ...outside.kept].map(tildePath),
        ],
      }
    },

    async redo(session) {
      const state = rewinds
      if (!capture || !state || state.session !== session) return { kind: "untracked" }
      try {
        return await redoFiles(state, session)
      } catch (error) {
        log.warn("redo restore failed", String(error))
        return { kind: "failed", reason: "could not read the snapshots" }
      } finally {
        release()
      }
    },
  }

  async function redoFiles(state: Rewinds, session: Session): Promise<FilesOutcome> {
    const snapshots = await capture?.snapshots
    if (!snapshots) return { kind: "failed", reason: "the snapshots are gone" }
    const after = lastAfter(state)
    if (!after) return { kind: "failed", reason: "no snapshot after the rewind" }
    const safety = await hold()
    if (!safety) return { kind: "failed", reason: "could not take a snapshot" }
    try {
      // Each path's target, from the R its source names; one the R could not read stays out, so it is kept.
      const files = new Map<string, TreeEntry | null>()
      const targetAts = new Map<string, number>()
      const created: string[] = []
      const bySource = Map.groupBy(state.paths, (path) => state.source.get(path) ?? 0)
      for (const [index, paths] of bySource) {
        const from = state.done[index]?.safety
        if (!from) continue
        // oxlint-disable-next-line no-await-in-loop -- one per rewind
        const [entries, changes] = await Promise.all([
          snapshots.entries(from.taken.tree, paths),
          snapshots.changes(from.taken.tree, after.taken.tree),
        ])
        const group = new Set(paths)
        // Absent from its target and there after the rewinds: made after that R was taken.
        created.push(...createdIn([changes]).filter((path) => group.has(path)))
        for (const path of paths) {
          targetAts.set(path, from.at)
          if (!covers(from.taken.unknown, path)) files.set(path, entries.get(path) ?? null)
        }
      }
      const first = state.done[0]?.safety
      const plan = await planRestore({
        snapshots,
        target: { files },
        targetAt: first?.at ?? 0,
        targetAts,
        safety: safety.taken,
        after: after.taken,
        paths: [...state.paths],
        created,
        writes: [],
        keepChanged: true,
      })
      const result = await applyRestore(plan)
      const moved = await restoreOutside(snapshots.store, [...state.outside.values()])
      const shown = chatPaths(snapshots.root, session.info?.cwd || cwd)
      return {
        kind: "done",
        paths: [...[...result.restored, ...result.deleted].map(shown), ...moved.restored, ...moved.deleted],
        kept: [...result.kept.map((file) => shown(file.path)), ...moved.kept.map(tildePath)],
      }
    } finally {
      capture?.release(safety.point)
    }
  }
}
