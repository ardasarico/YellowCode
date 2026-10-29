// opencode's tool calls as neutral ones: the kind, the row's summary, and what a finished call wrote, ran or found.
// Success metadata is open per tool, so each kind reads only its own fields; a field that does not fit is left out and
// the rest of the end stays.
import { isAbsolute, join } from "node:path"
import { z } from "zod"
import type { Questions } from "../../agent/ask.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { ToolId } from "../../agent/ids.ts"
import type { FileChange, Hunk, SubagentCall, ToolKind } from "../../agent/tools.ts"
import { oneLine, SUMMARY_LENGTH } from "../../session/tool-summary.ts"

const KINDS: Record<string, ToolKind> = {
  shell: "shell",
  read: "read",
  glob: "search",
  grep: "search",
  edit: "edit",
  write: "write",
  webfetch: "fetch",
  websearch: "websearch",
  subagent: "agent",
  question: "question",
  skill: "skill",
  execute: "other",
}

export const kindOf = (name: string): ToolKind => KINDS[name] ?? "other"

type Called = Extract<AgentEvent, { type: "tool.called" }>
type Ended = Extract<AgentEvent, { type: "tool.end" }>
type Content = { type: string; text?: string }[]

const fields = z.looseObject({
  path: z.string().optional(),
  command: z.string().optional(),
  pattern: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  // A skill's name, or the subagent session a call goes on with.
  id: z.string().optional(),
  sessionID: z.string().optional(),
  content: z.string().optional(),
  background: z.boolean().optional(),
})
type Fields = z.output<typeof fields>

const fieldsOf = (input: unknown): Fields => fields.safeParse(input).data ?? {}

// Relative paths are the session's folder's.
export const absolute = (path: string, directory: string) =>
  isAbsolute(path) || directory === "" ? path : join(directory, path)

const FILE_TOOLS = new Set<ToolKind>(["read", "edit", "write"])

// A path stays whole: the row cuts it from the start, so the file name stays. It is still drawn on one row.
const pathLine = (path: string) => (Bun.stripANSI(path).split("\n")[0] ?? "").replace(/\p{Cc}/gu, " ")

function summaryOf(kind: ToolKind, input: Fields, directory: string): string {
  const path = input.path === undefined ? undefined : absolute(input.path, directory)
  if (path !== undefined && (FILE_TOOLS.has(kind) || (input.command ?? input.pattern) === undefined))
    return pathLine(path)
  const value = input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.id ?? ""
  const line = oneLine(value.split("\n")[0])
  return line.length <= SUMMARY_LENGTH ? line : `${line.slice(0, SUMMARY_LENGTH - 1)}…`
}

function subagentOf(input: Fields): SubagentCall {
  const type = input.agent ?? ""
  return {
    name: oneLine(type) || "agent",
    task: input.description ?? "",
    prompt: input.prompt ?? "",
    type,
    model: input.model ?? "",
  }
}

const questionInput = z.looseObject({
  questions: z.array(
    z.looseObject({
      question: z.string(),
      header: z.string(),
      multiple: z.boolean().optional(),
      options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })),
    }),
  ),
})

// The question tool's pages as its form files them: `q<n>` in order, each taking a typed answer too.
function questionPages(input: Record<string, unknown>): Questions | null {
  const parsed = questionInput.safeParse(input).data
  if (!parsed) return null
  return {
    pages: parsed.questions.map((page, index) => ({
      key: `q${index}`,
      header: page.header,
      question: page.question,
      multi: page.multiple === true,
      gallery: false,
      custom: true,
      options: page.options.map((option) => ({
        label: option.label,
        description: option.description ?? null,
        preview: null,
        image: null,
      })),
    })),
  }
}

const questionMeta = z.looseObject({ answers: z.array(z.array(z.string())) })

// The question tool keeps its answers as a list in page order, which its form files as `q<n>`.
export function questionOutcome(metadata: unknown): Ended["outcome"] {
  const answers = questionMeta.safeParse(metadata).data?.answers
  if (!answers) return null
  const given = answers.flatMap((values, index): [string, string][] =>
    values.length > 0 ? [[`q${index}`, values.join(", ")]] : [],
  )
  return { status: "answered", answers: Object.fromEntries(given), notes: {} }
}

// The whole input of a call, once it is known. `background`: its work is known to go on in the background, though the
// input did not ask for it (Ctrl+B).
export function called(
  id: ToolId,
  name: string,
  input: Record<string, unknown>,
  directory: string,
  background = false,
): Called {
  const kind = kindOf(name)
  const known = fieldsOf(input)
  return {
    type: "tool.called",
    id,
    kind: null,
    name: null,
    title: null,
    input,
    summary: summaryOf(kind, known, directory),
    detail: null,
    command: kind === "shell" ? (known.command ?? null) : null,
    background: background || known.background === true,
    questions: kind === "question" ? questionPages(input) : null,
    agent: kind === "agent" ? subagentOf(known) : null,
    message: null,
    todos: null,
    at: 0,
  }
}

// A call that goes on with a subagent session it ran before.
export const resumes = (input: Record<string, unknown>) => fieldsOf(input).sessionID !== undefined

const fileEntry = z.looseObject({ file: z.string(), patch: z.string().optional(), status: z.string().optional() })
const editMeta = z.looseObject({ files: z.array(fileEntry) })
const shellMeta = z.looseObject({ exit: z.number().optional(), status: z.string().optional() })
const globMeta = z.looseObject({ count: z.number() })
const grepMeta = z.looseObject({ matches: z.number() })
// A shell's or a subagent's call that ends while its work goes on says `status: running`.
const taskMeta = z.looseObject({
  status: z.string().optional(),
  shellID: z.string().optional(),
  sessionID: z.string().optional(),
})

// A shell's or subagent's call that ended while its work went on.
export const goesOn = (name: string, metadata: unknown) =>
  ["shell", "agent"].includes(kindOf(name)) && taskMeta.safeParse(metadata).data?.status === "running"

// Only "modified" has been seen; "added" and "deleted" are guessed.
const CHANGES: Record<string, FileChange["change"]> = { added: "create", deleted: "delete" }

const lineCount = (value: string | undefined) => (value === undefined ? 1 : Number(value))

// opencode's patches start with `Index:`, `===`, `---` and `+++` lines; only what follows a hunk header counts.
function hunksOf(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  for (const line of patch.replace(/\n$/, "").split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      const [, oldStart, oldLines, newStart, newLines] = header
      hunks.push({
        oldStart: Number(oldStart),
        oldLines: lineCount(oldLines),
        newStart: Number(newStart),
        newLines: lineCount(newLines),
        lines: [],
      })
    } else if (/^[+\- ]/.test(line)) hunks.at(-1)?.lines.push(line)
  }
  return hunks
}

function editFiles(metadata: unknown, directory: string): FileChange[] {
  return (editMeta.safeParse(metadata).data?.files ?? []).map((file) => ({
    path: absolute(file.file, directory),
    change: CHANGES[file.status ?? ""] ?? "update",
    movedTo: null,
    patch: file.patch === undefined ? null : hunksOf(file.patch),
    after: null,
  }))
}

const readLines = (result: string) => result.split("\n").filter((line) => /^\d+: /.test(line)).length

function countOf(name: string, result: string, metadata: unknown): Ended["count"] {
  if (name === "read") return { n: readLines(result), noun: "line" }
  const glob = name === "glob" ? globMeta.safeParse(metadata).data : undefined
  if (glob) return { n: glob.count, noun: "file" }
  const grep = name === "grep" ? grepMeta.safeParse(metadata).data : undefined
  return grep ? { n: grep.matches, noun: "match" } : null
}

const textOf = (content: Content) =>
  content.flatMap((item) => (item.type === "text" && item.text !== undefined ? [item.text] : [])).join("\n")

const SUBAGENT = /^<subagent [^>]*>\n?([\s\S]*?)\n?<\/subagent>$/

// What the chat shows of a result: a subagent's report without its wrapper, a command that went well without the line
// that says its exit code. A command that failed keeps it, as nothing else on its row says how it ended.
function resultOf(kind: ToolKind, content: Content, exit: number | null): string {
  if (kind === "agent") {
    const text = textOf(content)
    return SUBAGENT.exec(text)?.[1] ?? text
  }
  if (kind !== "shell" || exit !== 0) return textOf(content)
  return textOf(content.filter((item) => item.text !== "Exited with code 0"))
}

export function blankEnd(id: ToolId, status: Ended["status"], result: string): Ended {
  return {
    type: "tool.end",
    id,
    status,
    result,
    images: [],
    patch: null,
    created: false,
    content: null,
    unchanged: false,
    exitCode: null,
    count: null,
    outcome: null,
    background: false,
    task: null,
    files: [],
    at: 0,
  }
}

// A call that succeeded. A shell or subagent whose work goes on in the background names its task. A command that
// exited with another code than 0 failed, as Claude's does.
export function succeeded(
  call: { id: ToolId; name: string; input: Record<string, unknown> },
  content: Content,
  metadata: unknown,
  directory: string,
): Ended {
  const kind = kindOf(call.name)
  const shell = kind === "shell" ? shellMeta.safeParse(metadata).data : undefined
  const exit = shell?.exit ?? null
  const result = resultOf(kind, content, exit)
  const end: Ended = {
    ...blankEnd(call.id, exit === null || exit === 0 ? "done" : "error", result),
    exitCode: exit,
    count: countOf(call.name, result, metadata),
  }
  const task = kind === "shell" || kind === "agent" ? taskMeta.safeParse(metadata).data : undefined
  if (task) {
    end.background = task.status === "running"
    end.task = (kind === "shell" ? task.shellID : task.sessionID) ?? null
  }
  if (kind === "edit") {
    end.files = editFiles(metadata, directory)
    end.patch = end.files[0]?.patch ?? null
  }
  if (kind === "question") end.outcome = questionOutcome(metadata)
  const input = fieldsOf(call.input)
  if (kind === "write" && input.path !== undefined && input.content !== undefined) {
    end.created = result.startsWith("Created")
    end.content = input.content
    end.files = [
      {
        path: absolute(input.path, directory),
        change: end.created ? "create" : "update",
        movedTo: null,
        patch: null,
        after: input.content,
      },
    ]
  }
  return end
}
