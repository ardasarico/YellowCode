import { shownText } from "./agent-message.ts"
import { relative } from "node:path"
import { z } from "zod"
import { fileInput, inputFile, WRITE_TOOLS } from "../rewind/common.ts"
import type { Item, ItemId, Session, Task, ToolCall } from "./types.ts"

export type FileChange = {
  path: string
  plus: number
  minus: number
  created: boolean
  // Changed through Bash, which only our own snapshots see.
  bash: boolean
  // Changed by someone else after Claude touched it, so a rewind would overwrite that.
  conflict: boolean
}

// `hidden` marks a prompt an earlier rewind hid: it cannot be picked again, but a rewind to an earlier prompt
// undoes it too.
export type RewindPoint = {
  userId: ItemId
  text: string
  files: FileChange[]
  hidden: boolean
  // No full snapshots: the prompt's files cannot be put back.
  untracked: boolean
  // Only claude's own backups cover the prompt, so only its Edit and Write calls can be undone.
  imported: boolean
  // Running background tasks the prompt started.
  tasks: string[]
  // Background shells the prompt started that ran on after its turns.
  shells: string[]
  // What a rewind to this prompt would restore or delete, as a dry run found it; null until one did.
  restores: string[] | null
  // Files outside the project the prompt changed that a rewind leaves as they are.
  outside: string[]
}

// What the session has rewound: `userId` and everything after it up to `last` are hidden until a redo or the next
// send. `last` is the newest item when the session rewound; what comes after it (a turn claude starts because a
// background task from a kept prompt finished) stays in view.
export type Rewound = { userId: ItemId; prompts: number; files: FileChange[]; keptFiles: boolean; last?: ItemId }

// At Enter the files had changed since the dialog showed its ⚠: the ⚠ paths and the files a rewind would change now.
export type RewindRecheck = { conflicts: string[]; paths: string[] }

// What only the snapshots know, by prompt index: live from the manifests, in a replay from the recording's sidecar.
export type RewindExtras = {
  // `edit`: an Edit/Write call the chat does not show, not Bash.
  bash: { prompt: number; path: string; plus: number; minus: number; edit?: boolean }[]
  conflicts: string[]
  untracked: number[]
  imported: number[]
  shells: { prompt: number; names: string[] }[]
  restores: { prompt: number; paths: string[] }[]
  outside: { prompt: number; path: string }[]
  // Works out `restores` for another prompt while the dialog is open.
  dryRun?: (prompt: number) => Promise<string[] | null>
}

// Worked out each time the rewind dialog opens; `selected` is the prompt the dialog opens on.
export type RewindPreview = (session: Session, selected: number) => Promise<RewindExtras | null>

function toolChange(tool: ToolCall, cwd: string): FileChange | null {
  if (!WRITE_TOOLS.has(tool.name) || tool.status !== "done" || tool.unchanged) return null
  const input = fileInput.safeParse(tool.input)
  const file = inputFile(tool.input)
  if (!file) return null
  let plus = 0
  let minus = 0
  for (const hunk of tool.patch ?? [])
    for (const line of hunk.lines) {
      if (line.startsWith("+")) plus++
      else if (line.startsWith("-")) minus++
    }
  // A new file written whole has no patch, only its content.
  if (tool.createdFile && plus === 0) {
    const content = (input.success ? (input.data.content ?? "") : "").replace(/\n$/, "")
    plus = content === "" ? 0 : content.split("\n").length
  }
  const path = cwd && file.startsWith(`${cwd}/`) ? relative(cwd, file) : file
  return { path, plus, minus, created: tool.createdFile, bash: false, conflict: false }
}

export function mergeChanges(changes: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const change of changes) {
    const seen = byPath.get(change.path)
    if (!seen) byPath.set(change.path, { ...change })
    else {
      seen.plus += change.plus
      seen.minus += change.minus
      seen.bash ||= change.bash
      seen.conflict ||= change.conflict
    }
  }
  return [...byPath.values()]
}

// Each prompt with the files its turn changed, subagents included, oldest first.
export function rewindPoints(session: Session, extras: RewindExtras | null): RewindPoint[] {
  // A resumed claude reports no cwd before its first turn; ours is the same folder.
  const cwd = session.info?.cwd || process.cwd()
  const points: { userId: ItemId; text: string; changes: FileChange[]; hidden: boolean }[] = []
  const collect = (item: Item | undefined, into: FileChange[]) => {
    if (item?.kind !== "tool") return
    const change = toolChange(item, cwd)
    if (change) into.push(change)
    for (const child of item.children) collect(session.byId[child], into)
  }
  const tasks: string[][] = []
  const started = (item: Item | undefined, into: string[]) => {
    if (item?.kind !== "tool") return
    const task = item.taskId ? session.tasks[item.taskId] : undefined
    if (task?.state === "running") into.push(task.description || task.command || task.name)
    for (const child of item.children) started(session.byId[child], into)
  }
  let hidden = false
  for (const id of session.items) {
    if (id === session.rewound?.userId) hidden = true
    const item = session.byId[id]
    if (item?.kind === "user") {
      points.push({ userId: id, text: shownText(item), changes: [], hidden })
      tasks.push([])
    } else {
      const current = points.at(-1)
      if (current) collect(item, current.changes)
      const running = tasks.at(-1)
      if (running) started(item, running)
    }
  }
  for (const { prompt, path, plus, minus, edit } of extras?.bash ?? []) {
    const point = points[prompt]
    if (point) point.changes.push({ path, plus, minus, created: false, bash: edit !== true, conflict: false })
  }
  const conflicts = new Set(extras?.conflicts ?? [])
  const untracked = new Set(extras?.untracked ?? [])
  const imported = new Set(extras?.imported ?? [])
  return points.map((point, at) => {
    const files = mergeChanges(point.changes)
    for (const file of files) file.conflict = conflicts.has(file.path)
    return {
      userId: point.userId,
      text: point.text,
      files,
      hidden: point.hidden,
      untracked: untracked.has(at),
      imported: imported.has(at),
      tasks: tasks[at] ?? [],
      shells: (extras?.shells ?? []).filter((shell) => shell.prompt === at).flatMap((shell) => shell.names),
      restores: extras?.restores.find((found) => found.prompt === at)?.paths ?? null,
      outside: (extras?.outside ?? []).filter((file) => file.prompt === at).map((file) => file.path),
    }
  })
}

// The files rewinding to `points[from]` puts back: what that prompt and every one after it changed, or, with a dry
// run's result, exactly what it would restore and delete.
export function undone(points: RewindPoint[], from: number, restores: string[] | null = null): FileChange[] {
  const merged = mergeChanges(points.slice(from).flatMap((point) => point.files))
  return restores ? onlyPaths(merged, restores) : merged
}

// The changes for exactly these paths; a path no change names counts as a Bash change.
export function onlyPaths(changes: FileChange[], paths: string[]): FileChange[] {
  const touched = new Set(paths)
  const found = changes.filter((file) => touched.has(file.path))
  const listed = new Set(found.map((file) => file.path))
  const rest = [...touched].filter((path) => !listed.has(path))
  return [...found, ...rest.map((path) => ({ path, plus: 0, minus: 0, created: false, bash: true, conflict: false }))]
}

// The background tasks still running that a call under the prompt `from` or any later one started.
export function rewoundTasks(session: Session, from: ItemId): Task[] {
  const found: Task[] = []
  const visit = (item: Item | undefined) => {
    if (item?.kind !== "tool") return
    const task = item.taskId ? session.tasks[item.taskId] : undefined
    if (task?.state === "running") found.push(task)
    for (const child of item.children) visit(session.byId[child])
  }
  const start = session.items.indexOf(from)
  if (start === -1) return found
  for (const id of session.items.slice(start)) visit(session.byId[id])
  return found
}

// Where the items a rewind hides start and end (exclusive) in `items`.
export function hiddenSpan(items: ItemId[], rewound: Rewound | null): { start: number; end: number } | null {
  const start = rewound ? items.indexOf(rewound.userId) : -1
  if (!rewound || start === -1) return null
  const last = rewound.last === undefined ? -1 : items.indexOf(rewound.last)
  return { start, end: last >= start ? last + 1 : items.length }
}

export function shownItems(items: ItemId[], rewound: Rewound | null): ItemId[] {
  const span = hiddenSpan(items, rewound)
  return span ? [...items.slice(0, span.start), ...items.slice(span.end)] : items
}

// The final reply of each turn claude started by itself after the rewind, oldest first.
export function keptReplies(session: Session): string[] {
  const span = hiddenSpan(session.items, session.rewound)
  if (!span) return []
  const replies: string[] = []
  let reply: string | null = null
  for (const id of session.items.slice(span.end)) {
    const item = session.byId[id]
    if (item?.kind === "text" && !item.local) reply = item.markdown
    else if (item?.kind === "turn-end") {
      if (reply !== null) replies.push(reply)
      reply = null
    }
  }
  return replies
}

// The uuids of the prompts a rewind hides that went out to claude, newest first; undefined for one sent without.
export function hiddenPrompts(session: Session): (string | undefined)[] {
  const start = session.rewound ? session.items.indexOf(session.rewound.userId) : -1
  if (start === -1) return []
  const prompts: (string | undefined)[] = []
  for (const id of session.items.slice(start)) {
    const item = session.byId[id]
    if (item?.kind === "user" && item.queue !== "not sent") prompts.unshift(item.uuid)
  }
  return prompts
}

const extrasFile = z.object({
  bash: z
    .array(
      z.object({
        prompt: z.number(),
        path: z.string(),
        plus: z.number(),
        minus: z.number(),
        edit: z.boolean().optional(),
      }),
    )
    .default([]),
  conflicts: z.array(z.string()).default([]),
  untracked: z.array(z.number()).default([]),
  imported: z.array(z.number()).default([]),
  shells: z.array(z.object({ prompt: z.number(), names: z.array(z.string()) })).default([]),
  restores: z.array(z.object({ prompt: z.number(), paths: z.array(z.string()) })).default([]),
  outside: z.array(z.object({ prompt: z.number(), path: z.string() })).default([]),
})

// A replay's mock extras sit next to its recording as `<name>.rewind.json`; most recordings have none.
export async function loadRewindExtras(recording: string): Promise<RewindExtras | null> {
  const file = Bun.file(recording.replace(/\.jsonl$/, ".rewind.json"))
  if (!(await file.exists())) return null
  const parsed = extrasFile.safeParse(await file.json().catch(() => null))
  return parsed.success ? parsed.data : null
}
