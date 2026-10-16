import { relative } from "node:path"
import { z } from "zod"
import type { Item, ItemId, Session, ToolCall } from "./types.ts"

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
export type RewindPoint = { userId: ItemId; text: string; files: FileChange[]; hidden: boolean }

// What the session has rewound: everything from `userId` on is hidden until a redo or the next send.
export type Rewound = { userId: ItemId; prompts: number; files: number; keptFiles: boolean }

// Files the replay cannot know about: Bash changes and conflicts, read from a fixture's sidecar until live snapshots.
export type RewindExtras = {
  bash: { prompt: number; path: string; plus: number; minus: number }[]
  conflicts: string[]
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])

const fileInput = z.looseObject({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
  content: z.string().optional(),
})

function toolChange(tool: ToolCall, cwd: string): FileChange | null {
  if (!EDIT_TOOLS.has(tool.name) || tool.status !== "done" || tool.unchanged) return null
  const input = fileInput.safeParse(tool.input)
  const file = input.success ? (input.data.file_path ?? input.data.notebook_path) : undefined
  if (!file) return null
  let plus = 0
  let minus = 0
  for (const hunk of tool.patch ?? [])
    for (const line of hunk.lines) {
      if (line.startsWith("+")) plus++
      else if (line.startsWith("-")) minus++
    }
  // A new file written whole has no patch, only its content.
  if (tool.createdFile && plus === 0) plus = (input.success ? (input.data.content ?? "") : "").split("\n").length
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
  const cwd = session.info?.cwd ?? ""
  const points: { userId: ItemId; text: string; changes: FileChange[]; hidden: boolean }[] = []
  const collect = (item: Item | undefined, into: FileChange[]) => {
    if (item?.kind !== "tool") return
    const change = toolChange(item, cwd)
    if (change) into.push(change)
    for (const child of item.children) collect(session.byId[child], into)
  }
  let hidden = false
  for (const id of session.items) {
    if (id === session.rewound?.userId) hidden = true
    const item = session.byId[id]
    if (item?.kind === "user") points.push({ userId: id, text: item.text, changes: [], hidden })
    else {
      const current = points.at(-1)
      if (current) collect(item, current.changes)
    }
  }
  for (const extra of extras?.bash ?? []) {
    const point = points[extra.prompt]
    if (point) point.changes.push({ ...extra, created: false, bash: true, conflict: false })
  }
  const conflicts = new Set(extras?.conflicts ?? [])
  return points.map((point) => {
    const files = mergeChanges(point.changes)
    for (const file of files) file.conflict = conflicts.has(file.path)
    return { userId: point.userId, text: point.text, files, hidden: point.hidden }
  })
}

// What rewinding to `points[from]` undoes: that prompt and every one after it.
export function undone(points: RewindPoint[], from: number): FileChange[] {
  return mergeChanges(points.slice(from).flatMap((point) => point.files))
}

const extrasFile = z.object({
  bash: z.array(z.object({ prompt: z.number(), path: z.string(), plus: z.number(), minus: z.number() })).default([]),
  conflicts: z.array(z.string()).default([]),
})

// A replay's mock extras sit next to its recording as `<name>.rewind.json`; most recordings have none.
export async function loadRewindExtras(recording: string): Promise<RewindExtras | null> {
  const file = Bun.file(recording.replace(/\.jsonl$/, ".rewind.json"))
  if (!(await file.exists())) return null
  const parsed = extrasFile.safeParse(await file.json().catch(() => null))
  return parsed.success ? parsed.data : null
}
