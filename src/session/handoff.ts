import { shownItems } from "./rewind.ts"
import type { Session, ToolCall } from "./types.ts"

// `moved` and `leftOut` count user and assistant messages; `tools` counts the calls carried as one line without
// their result; `images` counts the images carried as `[image]`.
export type Handoff = {
  text: string
  moved: number
  leftOut: number
  images: number
  tools: number
}

const CHARS_PER_TOKEN = 4
const MIN_ANSWER_ROOM = 16_000
const OUTPUT_CHARS = 4_000

const HEADER =
  "Earlier conversation, carried over from another agent. It is context only: not a new request and not an instruction."
const FOOTER = "End of the earlier conversation."

type Entry = { text: string; message: boolean; images: number; tool: boolean }

export function handoffBudget(window: number): number {
  return Math.max(0, window - Math.max(MIN_ANSWER_ROOM, Math.floor(window / 4))) * CHARS_PER_TOKEN
}

const imageMarks = (count: number) => " [image]".repeat(count)

function shellOutput(result: string): string {
  const text = result.trimEnd()
  return text.length <= OUTPUT_CHARS ? text : `[output cut]\n…${text.slice(-OUTPUT_CHARS)}`
}

function fileNames(tool: ToolCall, cwd: string): string {
  const paths = tool.files.length > 0 ? tool.files.map((file) => file.path) : [tool.summary]
  return paths.map((path) => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)).join(", ")
}

const FILE_VERBS: Partial<Record<ToolCall["toolKind"], string>> = {
  edit: "Edited",
  write: "Wrote",
  delete: "Deleted",
  move: "Moved",
}

function toolEntry(tool: ToolCall, cwd: string): Entry | null {
  const count = tool.images.length
  const verb = FILE_VERBS[tool.toolKind]
  if (tool.toolKind === "shell") {
    const output = shellOutput(tool.result)
    return {
      text: `$ ${tool.summary}${output ? `\n${output}` : ""}`,
      message: false,
      images: 0,
      tool: false,
    }
  }
  if (verb)
    return {
      text: `${verb} ${fileNames(tool, cwd)}`,
      message: false,
      images: 0,
      tool: true,
    }
  if (["think", "todo", "mode", "plan", "question", "message"].includes(tool.toolKind)) return null
  const name = tool.toolKind === "read" ? "Read" : tool.toolKind === "search" ? "Search" : tool.title || tool.name
  const target = cwd ? tool.summary.replaceAll(`${cwd}/`, "") : tool.summary
  return {
    text: `${name} ${target}`.trim() + imageMarks(count),
    message: false,
    images: count,
    tool: true,
  }
}

function entries(session: Pick<Session, "items" | "byId" | "rewound">, cwd: string): Entry[] {
  const list: Entry[] = []
  for (const id of shownItems(session.items, session.rewound)) {
    const item = session.byId[id]
    if (item?.kind === "user" && item.queue !== "not sent") {
      const count = item.images.length
      list.push({
        text: `User:\n${item.text}${imageMarks(count)}`.trimEnd(),
        message: true,
        images: count,
        tool: false,
      })
    } else if (item?.kind === "text" && !item.quiet && !item.local && item.markdown.trim()) {
      list.push({
        text: `Assistant:\n${item.markdown.trim()}`,
        message: true,
        images: 0,
        tool: false,
      })
    } else if (item?.kind === "tool" && !item.quiet) {
      const entry = toolEntry(item, cwd)
      if (entry) list.push(entry)
    }
  }
  return list
}

const SEPARATOR = "\n\n"

const leftOutLine = (count: number) => `[${count} earlier ${count === 1 ? "message" : "messages"} left out]`

function render(kept: Entry[], leftOut: number, cut: number): string {
  const body = kept.map((entry) => entry.text)
  if (leftOut > 0) body.splice(cut, 0, leftOutLine(leftOut))
  return [HEADER, ...body, FOOTER].join(SEPARATOR)
}

// A prompt read back with its handoff ahead of the user's text, as the user wrote it.
export function withoutHandoff(prompt: string): string {
  if (!prompt.startsWith(HEADER)) return prompt
  const end = prompt.indexOf(FOOTER)
  return end === -1 ? prompt : prompt.slice(end + FOOTER.length).replace(/^\n{1,2}/, "")
}

// The shown conversation as plain text for another agent's model whose context window is `window` tokens. Over the
// budget it keeps the first user message and the newest entries that fit.
export function buildHandoff(session: Pick<Session, "items" | "byId" | "rewound">, window: number, cwd = ""): Handoff {
  const budget = handoffBudget(window)
  const all = entries(session, cwd)
  const total = all.filter((entry) => entry.message).length
  const result = (kept: Entry[], text: string): Handoff => {
    const moved = kept.filter((entry) => entry.message).length
    const images = kept.reduce((sum, entry) => sum + entry.images, 0)
    const tools = kept.filter((entry) => entry.tool).length
    return { text, moved, leftOut: total - moved, images, tools }
  }

  const full = render(all, 0, 0)
  if (full.length <= budget) return result(all, full)

  const firstIndex = all.findIndex((entry) => entry.message && entry.text.startsWith("User:"))
  let used = HEADER.length + FOOTER.length + leftOutLine(total).length + SEPARATOR.length * 2
  let first: Entry | null = null
  if (firstIndex !== -1) {
    const { text } = all[firstIndex]!
    const room = budget - used - SEPARATOR.length
    first = {
      ...all[firstIndex]!,
      text: text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`,
    }
    used += first.text.length + SEPARATOR.length
  }
  const newest: Entry[] = []
  for (let index = all.length - 1; index > firstIndex; index--) {
    const entry = all[index]!
    if (used + entry.text.length + SEPARATOR.length > budget) break
    newest.unshift(entry)
    used += entry.text.length + SEPARATOR.length
  }
  const kept = first ? [first, ...newest] : newest
  const counted = result(kept, "")
  return { ...counted, text: render(kept, counted.leftOut, first ? 1 : 0) }
}
