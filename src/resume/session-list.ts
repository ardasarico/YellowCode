import { readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { z } from "zod"
import { parseJson } from "../protocol/json.ts"
import { agentMessageLabel } from "../session/agent-message.ts"
import { projectKey } from "./project-key.ts"

const WHOLE_LIMIT = 128 * 1024
const PART_SIZE = 64 * 1024
// A first prompt longer than the head, such as a pasted log or an image, is read up to this size.
const HEAD_LIMIT = 16 * 1024 * 1024
const MAX_FILES = 200
export const CHAIN_TYPES = new Set(["user", "assistant", "attachment", "system"])

export type HeadTail = { head: string[]; tail: string[] }

export type SessionEntry = {
  id: string
  path: string
  cwd: string
  branch: string | null
  title: string
  firstPrompt: string
  model: string | null
  modified: number
}

export type TitleFields = {
  customTitle: string | null
  aiTitle: string | null
  summary: string | null
  firstPrompt: string | null
  lastPrompt: string | null
}

const Block = z.looseObject({ type: z.string(), text: z.string().optional() })

const Line = z.looseObject({
  type: z.string(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  message: z
    .looseObject({
      content: z.union([z.string(), z.array(Block)]).optional(),
      model: z.string().optional(),
    })
    .optional(),
  customTitle: z.string().optional(),
  aiTitle: z.string().optional(),
  summary: z.string().optional(),
  lastPrompt: z.string().optional(),
})

type Line = z.infer<typeof Line>

const readsWhole = (size: number, headSize: number) => size <= Math.max(WHOLE_LIMIT, headSize + PART_SIZE)

export async function readHeadTail(path: string, size: number, headSize = PART_SIZE): Promise<HeadTail> {
  const file = Bun.file(path)
  if (readsWhole(size, headSize)) return { head: (await file.text()).split("\n").filter(Boolean), tail: [] }
  const head = (await file.slice(0, headSize).text()).split("\n").slice(0, -1)
  const tail = (await file.slice(size - PART_SIZE - 1, size).text()).split("\n").slice(1)
  return { head: head.filter(Boolean), tail: tail.filter(Boolean) }
}

export function commandPrompt(text: string): string {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim()
  if (name === undefined) return text
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? ""
  const command = name.startsWith("/") ? name : `/${name}`
  return args === "" ? command : `${command} ${args}`
}

const listPrompt = (text: string) => agentMessageLabel(text) ?? commandPrompt(text)

function promptOf(line: Line): string | null {
  if (line.type !== "user" || line.isMeta || line.isCompactSummary) return null
  const content = line.message?.content
  if (typeof content === "string") return listPrompt(content)
  if (!content || content.some((block) => block.type === "tool_result")) return null
  const text = content.find((block) => block.type === "text")?.text
  if (text?.trim()) return listPrompt(text)
  const images = content.filter((block) => block.type === "image")
  if (images.length > 0) return images.map((_, index) => `[Image ${index + 1}]`).join(" ")
  return text ?? null
}

function parseLines(lines: string[]): Line[] {
  const parsed: Line[] = []
  for (const text of lines) {
    const json = parseJson(text)
    const line = json.ok ? Line.safeParse(json.value) : null
    if (line?.success) parsed.push(line.data)
  }
  return parsed
}

// Escape sequences and other control characters would show as stray text in the lists.
function oneLine(text: string | null): string {
  return text
    ? Bun.stripANSI(text)
        .replace(/[\s\p{Cc}]+/gu, " ")
        .trim()
    : ""
}

// Shown in place of a title when a session has no words to name it by.
export const NO_PROMPT = "(no prompt)"

export function displayTitle(fields: TitleFields): string {
  const { customTitle, aiTitle, summary, firstPrompt, lastPrompt } = fields
  for (const text of [customTitle, aiTitle, summary, firstPrompt, lastPrompt]) {
    const title = oneLine(text)
    if (title !== "") return title
  }
  return ""
}

export function sessionEntry(path: string, lines: HeadTail, modified: number): SessionEntry | null {
  const head = parseLines(lines.head)
  let cwd: string | null = null
  let firstChain: Line | null = null
  let firstPrompt: string | null = null
  for (const line of head) {
    cwd ??= line.cwd ?? null
    if (CHAIN_TYPES.has(line.type)) firstChain ??= line
    firstPrompt ??= promptOf(line)
  }
  if (firstChain?.isSidechain) return null

  const fields: TitleFields = { customTitle: null, aiTitle: null, summary: null, firstPrompt, lastPrompt: null }
  let model: string | null = null
  let lastCwd: string | null = null
  let branch: string | null = null
  for (const line of [...head, ...parseLines(lines.tail)]) {
    lastCwd = line.cwd ?? lastCwd
    branch = line.gitBranch ?? branch
    if (line.type === "custom-title" && line.customTitle !== undefined) fields.customTitle = line.customTitle
    else if (line.type === "ai-title" && line.aiTitle !== undefined) fields.aiTitle = line.aiTitle
    else if (line.type === "summary" && line.summary !== undefined) fields.summary = line.summary
    else if (line.type === "last-prompt" && line.lastPrompt !== undefined)
      fields.lastPrompt = listPrompt(line.lastPrompt)
    else if (line.type === "assistant" && line.message?.model !== undefined) model = line.message.model
  }
  const prompt = firstPrompt ?? fields.lastPrompt
  if (prompt === null) return null

  return {
    id: basename(path, ".jsonl"),
    path,
    cwd: cwd ?? lastCwd ?? "",
    branch,
    title: displayTitle(fields),
    firstPrompt: prompt,
    model,
    modified,
  }
}

// A head that gives no entry is read again, four times longer, until it does or holds the whole file.
async function readEntry(path: string, size: number, modified: number): Promise<SessionEntry | null> {
  try {
    for (let headSize = PART_SIZE; ; headSize *= 4) {
      // oxlint-disable-next-line no-await-in-loop
      const entry = sessionEntry(path, await readHeadTail(path, size, headSize), modified)
      if (entry || readsWhole(size, headSize) || headSize >= HEAD_LIMIT) return entry
    }
  } catch {
    return null
  }
}

export async function listSessions(folder: string, cwd: string | null): Promise<SessionEntry[]> {
  let names: string[]
  try {
    const dirents = await readdir(folder, { withFileTypes: true })
    names = dirents.filter((dirent) => dirent.isFile() && dirent.name.endsWith(".jsonl")).map((dirent) => dirent.name)
  } catch {
    return []
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const path = join(folder, name)
      try {
        const info = await stat(path)
        return { path, size: info.size, modified: info.mtimeMs }
      } catch {
        return null
      }
    }),
  )
  const newest = files
    .filter((file) => file !== null)
    .toSorted((a, b) => b.modified - a.modified)
    .slice(0, MAX_FILES)
  const entries = await Promise.all(newest.map((file) => readEntry(file.path, file.size, file.modified)))
  const key = basename(folder)
  return entries.filter(
    (entry): entry is SessionEntry =>
      entry !== null && (cwd === null ? projectKey(entry.cwd) === key : entry.cwd === cwd),
  )
}
