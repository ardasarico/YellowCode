import { randomUUID } from "node:crypto"
import { constants, readFileSync } from "node:fs"
import { type FileHandle, lstat, open as openFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createEffect, createRoot, on } from "solid-js"
import { z } from "zod"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import { CLAUDE_PROJECTS } from "../resume/project-key.ts"
import type { SessionStore } from "../session/session.ts"
import { isShell } from "../session/shells.ts"
import type { ItemId, Session, ToolCall, UserMessage } from "../session/types.ts"
import type { Write } from "./restore.ts"
import { blobId, inRoot, inputFile, WRITE_TOOLS, within, writeManifest } from "./common.ts"
import { importBackups } from "./import.ts"
import { fileHash, keepBytes } from "./outside.ts"
import { type Change, openSnapshots, type Snapshots, type Taken } from "./snapshots.ts"

// Past this a prompt goes out without its snapshot, and its point is untracked.
export const BEFORE_CAP_MS = 3000
// Larger files outside the root are not kept, so they are not put back.
const OUTSIDE_LIMIT = 2 * 1024 * 1024
const STOP_WAIT_MS = 1000
// Each start takes this one again, so warm-ups leave a single ref behind.
const WARM_UP = "warm-up"

export type Point = Taken & { id: string }

// One stretch of claude's work for a prompt: from `before` to `after`. A "turn" is the prompt's own turn or one claude
// started by itself after it; an "agent" segment holds the Edit/Write calls a background agent the prompt started made
// while no turn ran, and its changes only the paths those calls touched. An "imported" segment comes from claude's own
// backups of a session made elsewhere (import.ts): `before` holds only the files its Edit/Write calls changed, and
// there is no `after`.
export type Segment = {
  kind: "turn" | "agent" | "imported"
  // null when the snapshot was not taken in time: the segment is untracked.
  before: Point | null
  // When the before snapshot started: restore's targetAt.
  beforeAt: number
  // The same for every prompt of a turn.
  after: Point | null
  changes: Change[]
  writes: Write[]
  // A turn claude started by itself is snapshotted only once it runs, so a call of its may land first. The paths its
  // Edit/Write calls changed before `before` was taken have their changes measured from `base.before`, the snapshot
  // from before the turn began, and go back to that.
  base: { before: Point; beforeAt: number; paths: string[] } | null
  // Files outside the root that main-thread Edit/Write calls changed, by absolute path: the blob of what the file held
  // before the first call (null: the call made it) and the hash of what the segment left there (null: gone).
  outside: Outside[]
  // Files outside the root the segment changed that cannot be put back: a subagent's call, or no original from claude.
  outsideKept: string[]
  // Imported only: the blob each path held after claude's last Edit/Write call of the prompt, where that is known.
  left?: Record<string, string>
}

export type Outside = { path: string; before: string | null; after: string | null }

// One per prompt, at <store>/prompts/<uuid>.json. Paths are relative to the snapshots' root.
export type Manifest = {
  uuid: string
  sessionId: string | null
  sentAt: number
  // In order. Other edits made between segments (the user's own, background shells, an agent's Bash) are in none.
  segments: Segment[]
  // Each path a segment changed, with the after id of the last segment that changed it.
  latest: Record<string, string>
  // Background shells the prompt started that ran on after one of its turns; their files are not rewound.
  shells: string[]
}

export type Capture = {
  // The store, null when files are not tracked here.
  snapshots: Promise<Snapshots | null>
  // Called at Enter. Resolves once the prompt's before snapshot is taken, or after BEFORE_CAP_MS.
  before(uuid: string, sessionId: string | null, session: SessionStore): Promise<void>
  // The prompt did not go out after all.
  drop(uuid: string): void
  // Closes the session's prompts as its turns end. The function returned stops that, closing the agent segments still
  // open first.
  follow(session: SessionStore): () => void
  // Closes the background agents' open segments with a snapshot taken now; resolves once their manifests are written.
  settle(): Promise<void>
  // At quit: no take starts any more, and the snapshots no manifest names are dropped once the takes still running end.
  stop(): Promise<void>
  // A snapshot of the files now that no prompt is waiting for, for a rewind and its /redo. Later agent segments start
  // from it like from any other take. Nothing drops it before release().
  snapshot(): Promise<Point | null>
  // The snapshot is not needed any more; its ref goes unless a manifest names it.
  release(point: Promise<Point | null>): void
  // A session made elsewhere opens: claude's own backups of its prompts that have no manifest are imported once.
  adopt(transcript: string, sessionId: string): void
  // Called as claude's request to run a tool is allowed: an Edit or Write outside the root gets the file's bytes read,
  // and the answer waits until they are. Only bytes read this way let a file outside the root be put back.
  asked(toolUseId: string, toolName: string, input: unknown): Promise<void>
}

// The turn being recorded. `own` marks a before taken for it alone, which goes when the segment does. `base` is the
// snapshot before a turn claude started by itself.
type Current = { before: Promise<Point | null>; beforeAt: number; from: ItemId | null; own: boolean; base?: Take }

type Prompt = {
  uuid: string
  sessionId: string | null
  session: Session
  sentAt: number
  // Set once the before is settled and the message goes out.
  out: boolean
  segments: Promise<Segment>[]
  current: Current
  shells: Set<string>
  // The before blob of each file outside the root the prompt changed, kept once per prompt: null when the file did
  // not exist, false when it cannot be put back.
  outsideBefore: Map<string, string | null | false>
  // Segments work out their files outside the root one after another.
  outsideDone: Promise<unknown>
}

// What a file outside the root held before a call: null bytes when there was no file.
type Before = { bytes: Uint8Array | null }

type Take = { point: Promise<Point | null>; at: number; base?: Take }

// `main` marks a call of the main thread, whose result says what the file held before.
type FileWrite = { id: ItemId; file: string; kind: Write["kind"]; main: boolean }

function writeOf(tool: ToolCall, main: boolean): FileWrite | null {
  if (!WRITE_TOOLS.has(tool.name) || tool.status !== "done") return null
  const file = inputFile(tool.input)
  if (file === undefined) return null
  return { id: tool.id, file, kind: tool.name === "Write" && tool.createdFile ? "create" : "update", main }
}

// Write and Edit calls from the item after `start` on, subagents' included.
function writesFrom(session: Session, start: number): FileWrite[] {
  const found: FileWrite[] = []
  const visit = (id: ItemId, main: boolean) => {
    const item = session.byId[id]
    if (item?.kind !== "tool") return
    const write = writeOf(item, main)
    if (write) found.push(write)
    for (const child of item.children) visit(child, false)
  }
  for (const id of session.items.slice(start)) visit(id, true)
  return found
}

export type AgentWrite = { id: ItemId; uuid: string; write: FileWrite }

// Edit/Write calls made inside agents, each with the prompt whose part of the chat the agent's call sits in.
export function agentWrites(session: Session): AgentWrite[] {
  const found: AgentWrite[] = []
  let uuid: string | undefined
  const visit = (id: ItemId, inAgent: boolean) => {
    const item = session.byId[id]
    if (item?.kind !== "tool") return
    const write = inAgent ? writeOf(item, false) : null
    if (write && uuid) found.push({ id, uuid, write })
    for (const child of item.children) visit(child, inAgent || item.agent !== null)
  }
  for (const id of session.items) {
    const item = session.byId[id]
    if (item?.kind === "user") uuid = item.uuid
    else visit(id, false)
  }
  return found
}

// Background shells started from the item after `start` up to the next prompt that still run.
function runningShells(session: Session, start: number): string[] {
  const found: string[] = []
  const visit = (id: ItemId) => {
    const item = session.byId[id]
    if (item?.kind !== "tool") return
    const task = item.taskId ? session.tasks[item.taskId] : undefined
    if (task && isShell(task) && task.state === "running") found.push(task.description || task.command)
    for (const child of item.children) visit(child)
  }
  for (const id of session.items.slice(start)) {
    if (session.byId[id]?.kind === "user") break
    visit(id)
  }
  return found
}

// Where each prompt sent with a uuid sits in the chat.
function promptsAt(session: Session): Map<string, number> {
  const at = new Map<string, number>()
  session.items.forEach((id, index) => {
    const item = session.byId[id]
    if (item?.kind === "user" && item.uuid) at.set(item.uuid, index)
  })
  return at
}

const pointFile = z.object({ id: z.string(), tree: z.string(), unknown: z.array(z.string()) })
const manifestFile = z.object({
  uuid: z.string(),
  sessionId: z.string().nullable(),
  sentAt: z.number(),
  segments: z.array(
    z.object({
      kind: z.enum(["turn", "agent", "imported"]),
      before: pointFile.nullable(),
      beforeAt: z.number(),
      after: pointFile.nullable(),
      changes: z.array(
        z.object({
          path: z.string(),
          status: z.enum(["A", "D", "M", "T"]),
          plus: z.number().nullable(),
          minus: z.number().nullable(),
        }),
      ),
      writes: z.array(z.object({ path: z.string(), kind: z.enum(["create", "update"]) })),
      base: z
        .object({ before: pointFile, beforeAt: z.number(), paths: z.array(z.string()) })
        .nullable()
        .default(null),
      outside: z
        .array(z.object({ path: z.string(), before: z.string().nullable(), after: z.string().nullable() }))
        .default([]),
      outsideKept: z.array(z.string()).default([]),
      left: z.record(z.string(), z.string()).optional(),
    }),
  ),
  latest: z.record(z.string(), z.string()),
  shells: z.array(z.string()),
})

// What an outside file holds before a call may change it: only a regular file up to OUTSIDE_LIMIT is read, never
// through a symlink; null when it cannot be read that way.
async function readBefore(file: string): Promise<Before | null> {
  let handle: FileHandle
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > OUTSIDE_LIMIT) return null
    handle = await openFile(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const missing = error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
    return missing ? { bytes: null } : null
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > OUTSIDE_LIMIT) return null
    return { bytes: await handle.readFile() }
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

// Each prompt's manifest. A prompt that never went out changed nothing, so it gets an empty one rather than the null
// of a prompt whose snapshots are missing.
export function promptManifests(store: string, prompts: UserMessage[]): (Manifest | null)[] {
  return prompts.map((prompt) => {
    if (prompt.queue === "not sent")
      return { uuid: prompt.uuid ?? "", sessionId: null, sentAt: 0, segments: [], latest: {}, shells: [] }
    return prompt.uuid ? readManifest(store, prompt.uuid) : null
  })
}

// The prompt's manifest, null when it has none or cannot be read.
export function readManifest(store: string, uuid: string): Manifest | null {
  let text: string
  try {
    text = readFileSync(join(store, "prompts", `${uuid}.json`), "utf8")
  } catch {
    return null
  }
  const json = parseJson(text)
  return json.ok ? (manifestFile.safeParse(json.value).data ?? null) : null
}

export function createCapture(cwd: string): Capture {
  // The first take pays for opening the store, so it happens before any prompt waits for one.
  const opened: Promise<Snapshots | null> = openSnapshots(cwd).then(
    (snapshots) => {
      if (snapshots) void snapshots.take(WARM_UP)
      return snapshots
    },
    (error: unknown) => {
      log.warn("snapshots off", String(error))
      return null
    },
  )
  // Prompts whose turn has not ended, from Enter on.
  const open = new Map<string, Prompt>()
  // What files outside the root held when claude asked to change them, by tool call; null when it could not be read.
  const befores = new Map<ItemId, Before | null>()
  // The blob ids of what main-thread Edit/Write calls found in their files, sha1 and sha256: null when there was none.
  const originals = new Map<ItemId, { sha1: string; sha256: string } | null>()
  let root: string | null = null
  void opened.then((snapshots) => {
    root = snapshots?.root ?? null
  })
  let writing = Promise.resolve()
  let importing = Promise.resolve()
  // Each followed session closes its agents' segments at every take.
  const followers: { waiting: () => boolean; close: (after: Take) => boolean }[] = []
  // The latest snapshot, which an agent segment found at the next take starts from.
  let latest: Take | null = null

  // Snapshots a segment names are kept even when the prompt that took them goes.
  const kept = new WeakSet<Promise<Point | null>>()
  const discarded = new WeakSet<Promise<Point | null>>()
  // Every snapshot this process took, the ones its manifests name, and the takes still running, for the sweep at quit.
  const ids = new Set<string>()
  const named = new Set<string>()
  const running = new Set<Promise<Point | null>>()
  let stopped = false
  const dropNow = (point: Promise<Point | null>) =>
    void Promise.all([point, opened])
      .then(([taken, snapshots]) => (taken && !kept.has(point) ? snapshots?.drop(taken.id) : undefined))
      .catch((error: unknown) => log.warn("snapshot not dropped", String(error)))
  // A snapshot no manifest will name: its ref goes as soon as it is taken. The latest one waits until the next take,
  // as an agent segment may still start from it.
  const discard = (point: Promise<Point | null>) => {
    if (discarded.has(point) || kept.has(point)) return
    discarded.add(point)
    if (latest?.point !== point) dropNow(point)
  }

  // A take nobody waits for any more is skipped, so it leaves no ref behind. Every take first closes the agent
  // segments found since the one before.
  const take = (unwanted = () => false): Promise<Point | null> => {
    const point = (async () => {
      const snapshots = await opened
      if (!snapshots) return null
      const id = randomUUID()
      const taken = await snapshots.take(id, () => unwanted() || stopped)
      if (taken) ids.add(id)
      return taken && { id, ...taken }
    })().catch((error: unknown) => {
      log.warn("snapshot not taken", String(error))
      return null
    })
    running.add(point)
    void point.finally(() => running.delete(point))
    const now = { point, at: Date.now() }
    const used = followers.map((follower) => follower.close(now)).some(Boolean)
    if (used) kept.add(point)
    const previous = latest
    latest = now
    if (previous && discarded.has(previous.point)) dropNow(previous.point)
    return point
  }

  const abandon = (prompt: Prompt) => {
    open.delete(prompt.uuid)
    if (prompt.current.own) discard(prompt.current.before)
  }

  // Files outside the root: the prompt's first before of each, and the hash the segment left.
  const outsideOf = async (prompt: Prompt, snapshots: Snapshots, writes: FileWrite[]) => {
    const outside: Outside[] = []
    const outsideKept: string[] = []
    const calls = Map.groupBy(
      writes.filter((write) => inRoot(snapshots.root, write.file) === null),
      (write) => write.file,
    )
    for (const [file, group] of calls) {
      const found = group.map((call) => befores.get(call.id))
      for (const call of group) befores.delete(call.id)
      if (group.some((call) => !call.main)) {
        outsideKept.push(file)
        continue
      }
      let before = prompt.outsideBefore.get(file)
      if (before === undefined) {
        const first = found[0]
        // oxlint-disable-next-line no-await-in-loop -- a few files, each a git call
        const blob = first?.bytes ? await keepBytes(snapshots.store, first.bytes) : null
        before = !first ? false : first.bytes === null ? null : (blob ?? false)
        prompt.outsideBefore.set(file, before)
      }
      // oxlint-disable-next-line no-await-in-loop
      const now = await fileHash(snapshots.store, file)
      if (before === false || now === undefined) outsideKept.push(file)
      else outside.push({ path: file, before, after: now })
    }
    return { outside, outsideKept }
  }

  const segment = async (
    prompt: Prompt,
    kind: Segment["kind"],
    from: Take,
    after: Promise<Point | null>,
    writes: FileWrite[],
  ): Promise<Segment> => {
    // After the segment's end, and after the prompt's segments before it.
    const outsideFiles = prompt.outsideDone.then(async () => {
      const [snapshots] = await Promise.all([opened, after])
      return snapshots ? outsideOf(prompt, snapshots, writes) : { outside: [], outsideKept: [] }
    })
    prompt.outsideDone = outsideFiles.catch(() => {})
    const [snapshots, before, end, files] = await Promise.all([opened, from.point, after, outsideFiles])
    const paths = writes.flatMap(({ file, kind: writeKind }) => {
      const path = snapshots ? inRoot(snapshots.root, file) : null
      return path === null ? [] : [{ path, kind: writeKind }]
    })
    let changes = snapshots && before && end ? await snapshots.changes(before.tree, end.tree) : []
    const touched = new Set(paths.map((write) => write.path))
    if (kind === "agent") changes = changes.filter((change) => touched.has(change.path))
    let base: Segment["base"] = null
    const earlier = from.base ? await from.base.point : null
    if (from.base && earlier && snapshots && before && end) {
      const candidates = (await snapshots.changes(earlier.tree, before.tree)).flatMap((change) =>
        touched.has(change.path) ? [change.path] : [],
      )
      // Only where claude's own first call found the file as the base holds it; a change of the user's in the gap
      // stays out of the turn.
      const held = await snapshots.entries(earlier.tree, candidates)
      const moved = new Set(
        candidates.filter((path) => {
          const first = writes.find((write) => inRoot(snapshots.root, write.file) === path)
          const found = first?.main ? originals.get(first.id) : undefined
          const entry = held.get(path)
          if (found === undefined) return false
          if (found === null) return entry === undefined
          return entry !== undefined && (entry.sha.length === 64 ? found.sha256 : found.sha1) === entry.sha
        }),
      )
      if (moved.size > 0) {
        const fromBase = await snapshots.changes(earlier.tree, end.tree)
        changes = [
          ...changes.filter((change) => !moved.has(change.path)),
          ...fromBase.filter((change) => moved.has(change.path)),
        ]
        base = { before: earlier, beforeAt: from.base.at, paths: [...moved] }
      }
    }
    return { kind, before, beforeAt: from.at, after: end, changes, writes: paths, base, ...files }
  }

  const record = (prompt: Prompt) => {
    writing = writing
      .then(async () => {
        const snapshots = await opened
        if (!snapshots) return
        const segments = await Promise.all(prompt.segments)
        const latestAfter: Record<string, string> = {}
        for (const { after, changes } of segments)
          for (const { path } of changes) if (after) latestAfter[path] = after.id
        const manifest: Manifest = {
          uuid: prompt.uuid,
          sessionId: prompt.sessionId,
          sentAt: prompt.sentAt,
          segments,
          latest: latestAfter,
          shells: [...prompt.shells],
        }
        writeManifest(snapshots.store, manifest)
        for (const part of segments)
          for (const point of [part.before, part.after, part.base?.before]) if (point) named.add(point.id)
        log.info("prompt manifest written", {
          uuid: prompt.uuid,
          segments: segments.map((part) => ({
            kind: part.kind,
            before: part.before?.id ?? null,
            after: part.after?.id ?? null,
            changes: part.changes.length,
            writes: part.writes.length,
          })),
          shells: manifest.shells.length,
        })
      })
      .catch((error: unknown) => log.warn("prompt manifest not written", { uuid: prompt.uuid, error: String(error) }))
  }

  return {
    snapshots: opened,

    async before(uuid, sessionId, session) {
      const beforeAt = Date.now()
      // The check runs once the take starts, after `taking` and `prompt` are set.
      const taking: Promise<Point | null> = take(() => prompt.current.before !== taking || !open.has(uuid))
      const prompt: Prompt = {
        uuid,
        sessionId,
        session: session.state,
        sentAt: beforeAt,
        out: false,
        segments: [],
        current: { before: taking, beforeAt, from: null, own: true },
        shells: new Set(),
        outsideBefore: new Map(),
        outsideDone: Promise.resolve(),
      }
      open.set(uuid, prompt)
      // A turn that ends meanwhile gives the prompt that turn's after as its before, which is then waited for.
      const deadline = beforeAt + BEFORE_CAP_MS
      let waited = prompt.current.before
      while (true) {
        // oxlint-disable-next-line no-await-in-loop -- each wait depends on what the one before found
        const point = await within(waited, Math.max(0, deadline - Date.now()))
        // A turn's after stays the before even when it comes late; only the prompt's own take is given up.
        if (point === undefined && prompt.current.before === waited && prompt.current.own) {
          log.warn("prompt sent before its snapshot", { uuid, ms: BEFORE_CAP_MS })
          discard(waited)
          prompt.current = { ...prompt.current, before: Promise.resolve(null), own: false }
        }
        if (point === undefined || prompt.current.before === waited) break
        waited = prompt.current.before
      }
      prompt.sentAt = Date.now()
      prompt.out = true
    },

    drop(uuid) {
      const prompt = open.get(uuid)
      if (prompt) abandon(prompt)
    },

    async asked(toolUseId, toolName, input) {
      const file = inputFile(input)
      if (!WRITE_TOOLS.has(toolName) || file === undefined) return
      // The answer does not wait for the store to open; a file found inside the root afterwards is let go.
      if (root !== null && inRoot(root, file) !== null) return
      befores.set(toolUseId, await readBefore(file))
      void opened.then((snapshots) => {
        if (!snapshots || inRoot(snapshots.root, file) !== null) befores.delete(toolUseId)
      })
    },

    async stop() {
      stopped = true
      await Promise.race([Promise.all(running), Bun.sleep(STOP_WAIT_MS)])
      await writing
      const snapshots = await opened
      const stray = [...ids].filter((id) => !named.has(id))
      if (!snapshots || stray.length === 0) return
      await Promise.all(stray.map((id) => snapshots.drop(id).catch(() => {})))
      log.info("snapshots no manifest names dropped", { count: stray.length })
    },

    async settle() {
      if (followers.some((follower) => follower.waiting())) void take()
      await Promise.all([writing, importing])
    },

    adopt(transcript, sessionId) {
      importing = importing.then(async () => {
        const snapshots = await opened
        const folder = join(dirname(CLAUDE_PROJECTS), "file-history", sessionId)
        if (snapshots) await importBackups(snapshots, transcript, sessionId, folder)
      })
    },

    snapshot: () => take(),

    release: discard,

    follow(session) {
      const state = session.state
      session.onFileOriginal((toolUseId, original) => {
        const bytes = original === null ? null : Buffer.from(original)
        originals.set(toolUseId, bytes && { sha1: blobId(bytes, ""), sha256: blobId(bytes, "0".repeat(64)) })
      })
      // Prompts whose first turn ended, and the latest of them, which a turn claude starts by itself goes on.
      const closed = new Map<string, Prompt>()
      let last: Prompt | null = null
      // Agent calls already counted: in a turn, or in an agent segment.
      const seen = new Set<ItemId>()

      // The agent calls made since the last take belong to no turn: each prompt that started their agent gets them
      // as a segment from that take to this one.
      const unseen = () => agentWrites(state).filter((call) => !seen.has(call.id) && closed.has(call.uuid))
      const close = (after: Take) => {
        const found = agentWrites(state).filter((call) => !seen.has(call.id))
        for (const call of found) seen.add(call.id)
        const byPrompt = Map.groupBy(
          found.filter((call) => closed.has(call.uuid)),
          (call) => call.uuid,
        )
        if (byPrompt.size === 0 || !latest) return false
        const from = latest
        kept.add(from.point)
        for (const [uuid, calls] of byPrompt) {
          const prompt = closed.get(uuid)
          if (!prompt) continue
          prompt.segments.push(
            segment(
              prompt,
              "agent",
              from,
              after.point,
              calls.map((call) => call.write),
            ),
          )
          record(prompt)
        }
        return true
      }
      const follower = { waiting: () => unseen().length > 0, close }
      followers.push(follower)

      const turnEnded = () => {
        for (const call of agentWrites(state)) seen.add(call.id)
        const at = promptsAt(state)
        const closing: Prompt[] = []
        const waiting: Prompt[] = []
        for (const prompt of open.values()) {
          if (prompt.session !== state) continue
          const index = at.get(prompt.uuid)
          const item = index === undefined ? undefined : state.byId[state.items[index] ?? ""]
          // Gone with a /clear, or never sent.
          if (item?.kind !== "user" || item.queue === "not sent") abandon(prompt)
          else if (item.queue === "queued" || !prompt.out) waiting.push(prompt)
          else closing.push(prompt)
        }
        if (closing.length === 0 && waiting.length === 0) return
        const after = take()
        // A message that waited through this turn runs next, from the files as this turn left them.
        for (const prompt of waiting) {
          if (prompt.current.own) discard(prompt.current.before)
          prompt.current = { before: after, beforeAt: Date.now(), from: state.items.at(-1) ?? null, own: false }
        }
        for (const prompt of closing.toSorted((a, b) => a.sentAt - b.sentAt)) {
          open.delete(prompt.uuid)
          closed.set(prompt.uuid, prompt)
          last = prompt
          const { current } = prompt
          const start = at.get(prompt.uuid) ?? 0
          const from = Math.max(start, current.from === null ? -1 : state.items.indexOf(current.from))
          const writes = writesFrom(state, from + 1)
          for (const shell of runningShells(state, start + 1)) prompt.shells.add(shell)
          const begin: Take = { point: current.before, at: current.beforeAt, base: current.base }
          prompt.segments.push(segment(prompt, "turn", begin, after, writes))
          record(prompt)
        }
        // A call that was denied or failed never reaches a segment, so what was kept for it goes with the turn.
        const staleBefores = [...befores.keys()]
        const staleOriginals = [...originals.keys()]
        void Promise.allSettled(closing.flatMap((prompt) => prompt.segments)).then(() => {
          for (const id of staleBefores) befores.delete(id)
          for (const id of staleOriginals) originals.delete(id)
        })
      }

      // A turn claude starts by itself goes on the last prompt as a segment of its own, from a snapshot taken now.
      const claudeStarted = () => {
        if (!last || open.has(last.uuid) || !promptsAt(state).has(last.uuid)) return
        const base = latest && !discarded.has(latest.point) ? latest : undefined
        if (base) kept.add(base.point)
        last.current = {
          before: take(),
          beforeAt: Date.now(),
          from: state.items.at(-1) ?? null,
          own: true,
          base,
        }
        open.set(last.uuid, last)
      }

      return createRoot((dispose) => {
        createEffect(
          on(
            () => state.turn,
            (turn, previous) => {
              if (turn === "claude" && previous === null) claudeStarted()
              else if (turn === null && previous) turnEnded()
            },
            { defer: true },
          ),
        )
        return () => {
          if (follower.waiting()) void take()
          const index = followers.indexOf(follower)
          if (index !== -1) followers.splice(index, 1)
          dispose()
        }
      })
    },
  }
}
