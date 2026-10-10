import { readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { z } from "zod"
import { parseJson } from "../protocol/json.ts"
import { projectKey } from "./project-key.ts"

const WHOLE_LIMIT = 128 * 1024
const PART_SIZE = 64 * 1024
const MAX_FILES = 200
export const CHAIN_TYPES = new Set(["user", "assistant", "attachment", "system"])

export type HeadTail = { head: string[]; tail: string[] }

export type SessionEntry = {
  id: string
  path: string
  cwd: string
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

export async function readHeadTail(path: string, size: number): Promise<HeadTail> {
  const file = Bun.file(path)
  if (size <= WHOLE_LIMIT) return { head: (await file.text()).split("\n").filter(Boolean), tail: [] }
  const head = (await file.slice(0, PART_SIZE).text()).split("\n").slice(0, -1)
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

function promptOf(line: Line): string | null {
  if (line.type !== "user" || line.isMeta || line.isCompactSummary) return null
  const content = line.message?.content
  if (typeof content === "string") return commandPrompt(content)
  if (!content || content.some((block) => block.type === "tool_result")) return null
  const text = content.find((block) => block.type === "text")?.text
  return text === undefined ? null : commandPrompt(text)
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

function oneLine(text: string | null): string {
  return text?.replace(/\s+/g, " ").trim() ?? ""
}

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
  for (const line of [...head, ...parseLines(lines.tail)]) {
    lastCwd = line.cwd ?? lastCwd
    if (line.type === "custom-title" && line.customTitle !== undefined) fields.customTitle = line.customTitle
    else if (line.type === "ai-title" && line.aiTitle !== undefined) fields.aiTitle = line.aiTitle
    else if (line.type === "summary" && line.summary !== undefined) fields.summary = line.summary
    else if (line.type === "last-prompt" && line.lastPrompt !== undefined) fields.lastPrompt = line.lastPrompt
    else if (line.type === "assistant" && line.message?.model !== undefined) model = line.message.model
  }
  const prompt = firstPrompt ?? fields.lastPrompt
  if (prompt === null) return null

  return {
    id: basename(path, ".jsonl"),
    path,
    cwd: cwd ?? lastCwd ?? "",
    title: displayTitle(fields),
    firstPrompt: prompt,
    model,
    modified,
  }
}

async function readEntry(path: string, size: number, modified: number): Promise<SessionEntry | null> {
  try {
    return sessionEntry(path, await readHeadTail(path, size), modified)
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
