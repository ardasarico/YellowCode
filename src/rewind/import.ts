import { existsSync, lstatSync, readFileSync } from "node:fs"
import { basename, isAbsolute, join } from "node:path"
import { z } from "zod"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import { blobId, fileInput, inputFile, inRoot, WRITE_TOOLS, writeManifest } from "./common.ts"
import type { Manifest } from "./live-rewind.ts"
import type { Write } from "./restore.ts"
import type { Change, Planted, Snapshots } from "./snapshots.ts"

// Claude Code keeps a copy of each file its Edit/Write calls change, as the file was before the prompt, in
// <config>/file-history/<session id>/. The transcript names them per prompt: a `file-history-snapshot` line keyed by
// the prompt's uuid, and `file-history-delta` lines for files first tracked during that prompt. A null backup means
// the file did not exist.

const backup = z.looseObject({
  backupFileName: z
    .string()
    .regex(/^[0-9a-f]+@v\d+$/)
    .nullable(),
  realParentDir: z.string().optional(),
})
const snapshotLine = z.looseObject({
  isSnapshotUpdate: z.boolean().optional(),
  snapshot: z.looseObject({
    messageId: z.string(),
    trackedFileBackups: z.record(z.string(), backup),
    timestamp: z.string(),
  }),
})
const deltaLine = z.looseObject({ snapshotMessageId: z.string(), trackingPath: z.string(), backup })
const entry = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  message: z.looseObject({ content: z.unknown() }).optional(),
  toolUseResult: z.unknown().optional(),
})
const toolUse = z.looseObject({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() })
const toolResult = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
})
const editResult = z.looseObject({
  originalFile: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
})

// What claude's backups say about one prompt. Paths are absolute.
export type PromptHistory = {
  uuid: string
  at: number
  // Backup file name per file, null when the file did not exist before the prompt.
  backups: Map<string, string | null>
  // Files the prompt's Edit/Write calls changed, with what Write reported; null for a file only a delta line names (a
  // subagent's call).
  writes: Map<string, Write["kind"] | null>
  // What the prompt's last Edit/Write call left in each file; null when that cannot be worked out.
  left: Map<string, string | null>
}

const blocks = (content: unknown): unknown[] => (Array.isArray(content) ? content : [])

// The file a backup entry stands for. The tracking path is relative to the folder claude started in, which the
// transcript does not keep, so the backup's own folder decides, and the backup's name must carry the hash of the path.
function backedUp(trackingPath: string, found: z.infer<typeof backup>): string | null {
  if (!found.realParentDir) return null
  const file = join(found.realParentDir, basename(trackingPath))
  const name = found.backupFileName
  if (name === null) return file
  const hash = new Bun.CryptoHasher("sha256").update(file).digest("hex").slice(0, 16)
  return name.startsWith(`${hash}@`) ? file : null
}

// The file's text after an Edit or Write call, from what the call and its result report.
function leftBy(name: string, input: unknown, result: unknown): string | null {
  if (name === "Write") return fileInput.safeParse(input).data?.content ?? null
  const edit = name === "Edit" ? editResult.safeParse(result).data : undefined
  if (!edit?.originalFile.includes(edit.oldString)) return null
  if (edit.replaceAll) return edit.originalFile.split(edit.oldString).join(edit.newString)
  return edit.originalFile.replace(edit.oldString, () => edit.newString)
}

// The prompts with backups, in transcript order. Null when a file-history line has a shape this version does not know.
export function readHistory(text: string): PromptHistory[] | null {
  const lines = text.split("\n").flatMap((line) => {
    const json = line.trim() ? parseJson(line) : null
    return json?.ok ? [json.value] : []
  })
  const byPrompt = new Map<string, { at: number; tracked: Map<string, string | null>; touched: Set<string> }>()
  for (const line of lines) {
    const type = entry.safeParse(line).data?.type
    if (type === "file-history-snapshot") {
      const parsed = snapshotLine.safeParse(line).data
      const at = parsed ? Date.parse(parsed.snapshot.timestamp) : Number.NaN
      if (!parsed || Number.isNaN(at)) return null
      const { messageId, trackedFileBackups } = parsed.snapshot
      const found = byPrompt.get(messageId) ?? { at, tracked: new Map(), touched: new Set() }
      for (const [path, file] of Object.entries(trackedFileBackups)) {
        const full = backedUp(path, file)
        if (full) found.tracked.set(full, file.backupFileName)
      }
      byPrompt.set(messageId, found)
    } else if (type === "file-history-delta") {
      const parsed = deltaLine.safeParse(line).data
      if (!parsed) return null
      const found = byPrompt.get(parsed.snapshotMessageId)
      const full = backedUp(parsed.trackingPath, parsed.backup)
      if (!found || !full) continue
      if (!found.tracked.has(full)) found.tracked.set(full, parsed.backup.backupFileName)
      found.touched.add(full)
    }
  }

  // Each transcript line belongs to the prompt its parent chain leads back to.
  const promptOf = new Map<string, string>()
  const prompts: string[] = []
  const calls = new Map<string, { prompt: string; file: string; name: string; input: unknown }>()
  const writes = new Map<string, Map<string, Write["kind"]>>()
  const left = new Map<string, Map<string, string | null>>()
  for (const line of lines) {
    const parsed = entry.safeParse(line).data
    if (!parsed?.uuid) continue
    const isPrompt = parsed.type === "user" && byPrompt.has(parsed.uuid) && !promptOf.has(parsed.uuid)
    const prompt = isPrompt ? parsed.uuid : parsed.parentUuid ? promptOf.get(parsed.parentUuid) : undefined
    if (prompt === undefined) continue
    promptOf.set(parsed.uuid, prompt)
    if (isPrompt) prompts.push(prompt)
    for (const block of blocks(parsed.message?.content)) {
      const use = toolUse.safeParse(block).data
      const file = use && WRITE_TOOLS.has(use.name) ? inputFile(use.input) : undefined
      if (use && file && isAbsolute(file)) calls.set(use.id, { prompt, file, name: use.name, input: use.input })
      const result = toolResult.safeParse(block).data
      const call = result ? calls.get(result.tool_use_id) : undefined
      const reported = parsed.toolUseResult
      if (!call || result?.is_error || typeof reported !== "object" || reported === null) continue
      const created = call.name === "Write" && "type" in reported && reported.type === "create"
      const files = writes.get(call.prompt) ?? new Map<string, Write["kind"]>()
      files.set(call.file, files.get(call.file) === "update" || !created ? "update" : "create")
      writes.set(call.prompt, files)
      const texts = left.get(call.prompt) ?? new Map<string, string | null>()
      texts.set(call.file, leftBy(call.name, call.input, reported))
      left.set(call.prompt, texts)
    }
  }

  return prompts.flatMap((uuid) => {
    const found = byPrompt.get(uuid)
    if (!found) return []
    const changed = new Map<string, Write["kind"] | null>(writes.get(uuid))
    for (const file of found.touched) if (!changed.has(file)) changed.set(file, null)
    return [{ uuid, at: found.at, backups: found.tracked, writes: changed, left: left.get(uuid) ?? new Map() }]
  })
}

// The import of one session: each prompt that has no manifest yet gets an imported one, from the backups of the files
// its Edit/Write calls changed (`folder` is the session's file-history folder). A file without a readable backup is
// listed as unknown, so a rewind keeps it.
export async function importBackups(
  snapshots: Snapshots,
  transcript: string,
  sessionId: string,
  folder: string,
): Promise<void> {
  try {
    const history = readHistory(readFileSync(transcript, "utf8"))
    if (!history) {
      log.info("claude backups not imported", { sessionId, reason: "unknown format" })
      return
    }
    const fresh = history.filter((prompt) => !existsSync(join(snapshots.store, "prompts", `${prompt.uuid}.json`)))
    for (const prompt of fresh) {
      // oxlint-disable-next-line no-await-in-loop -- one tree per prompt, in the store's queue anyway
      writeManifest(snapshots.store, await imported(snapshots, folder, sessionId, prompt))
    }
    if (fresh.length > 0) log.info("claude backups imported", { sessionId, prompts: fresh.length })
  } catch (error) {
    log.warn("claude backups not imported", { sessionId, error: String(error) })
  }
}

async function imported(
  snapshots: Snapshots,
  folder: string,
  sessionId: string,
  prompt: PromptHistory,
): Promise<Manifest> {
  const { root } = snapshots
  const backups = new Map<string, string | null>()
  for (const [file, name] of prompt.backups) {
    const path = inRoot(root, file)
    if (path !== null) backups.set(path, name)
  }
  const planted: Planted[] = []
  const changes: Change[] = []
  const unknown: string[] = []
  const writes: Write[] = []
  const texts = new Map<string, string>()
  for (const [file, kind] of prompt.writes) {
    const path = inRoot(root, file)
    if (path === null || changes.some((change) => change.path === path)) continue
    if (kind) writes.push({ path, kind })
    const name = backups.get(path)
    const source = name ? join(folder, name) : null
    const readable = source !== null && lstatSync(source, { throwIfNoEntry: false })?.isFile() === true
    const text = prompt.left.get(file)
    // Claude reports a CRLF file's text with LF endings and writes it back with CRLF.
    const crlf = readable && source !== null && readFileSync(source).includes("\r\n")
    if (typeof text === "string") texts.set(path, crlf && !text.includes("\r\n") ? text.replaceAll("\n", "\r\n") : text)
    if (name === undefined || (source && !readable)) unknown.push(path)
    else if (source) {
      const executable = ((lstatSync(join(root, path), { throwIfNoEntry: false })?.mode ?? 0) & 0o111) !== 0
      planted.push({ path, source, mode: executable ? "100755" : "100644" })
    }
    changes.push({ path, status: name === null ? "A" : "M", plus: null, minus: null })
  }
  const id = `import-${prompt.uuid}`
  const before = await snapshots.plant(id, planted)
  const left: Record<string, string> = {}
  for (const [path, text] of texts) left[path] = blobId(Buffer.from(text), before.tree)
  return {
    uuid: prompt.uuid,
    sessionId,
    // Pruning counts from the import, which is when the store got these backups.
    sentAt: Date.now(),
    segments: [
      {
        kind: "imported",
        before: { id, tree: before.tree, unknown },
        beforeAt: prompt.at,
        after: null,
        changes,
        writes,
        base: null,
        outside: [],
        outsideKept: [],
        left,
      },
    ],
    latest: {},
    shells: [],
  }
}
