// Codex's tool items as neutral calls: the kind, the row's name and summary, and what a finished call wrote, ran or
// found. Reads and searches are shell commands Codex parsed into actions; apply_patch is a fileChange item.
import { basename, extname, isAbsolute, join } from "node:path"
import type { AgentEvent } from "../../agent/events.ts"
import type { ToolId } from "../../agent/ids.ts"
import type { FileChange, Image, SubagentCall, ToolKind } from "../../agent/tools.ts"
import { OWN_ASK } from "../../protocol/messages.ts"
import { oneLine, SUMMARY_LENGTH } from "../../session/tool-summary.ts"
import { questionsOf } from "../claude/ask-input.ts"
import { summarizeToolInput } from "../claude/summary.ts"
import { resultOutcome } from "../claude/outcome.ts"
import { hunksOf } from "../hunks.ts"
import type { ThreadItem } from "./wire/items.ts"

type Called = Extract<AgentEvent, { type: "tool.called" }>
type Ended = Extract<AgentEvent, { type: "tool.end" }>
type Item<T extends ThreadItem["type"]> = Extract<ThreadItem, { type: T }>

const TOOL_TYPES = [
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
  "sleep",
  "functionCallOutput",
  "hookPrompt",
] as const

// The name our ask tool has on Codex.
export const ASK = "ask"

export type ToolItem = Extract<ThreadItem, { type: (typeof TOOL_TYPES)[number] }>

const toolTypes: ReadonlySet<string> = new Set(TOOL_TYPES)
export const isTool = (item: ThreadItem): item is ToolItem => toolTypes.has(item.type)

// What `tool.start` and `tool.called` say of a call.
export type Call = {
  name: string
  kind: ToolKind
  title: string
  mcp: { server: string; tool: string } | null
  input: unknown
  summary: string
  command: string | null
  agent: SubagentCall | null
  // A message to a subagent: the thread it goes to.
  message: { to: string; text: string } | null
}

// A recording's paths start with its `<root>` placeholder, which is not absolute, so a path already in the folder
// stays as it is.
const absolute = (path: string, directory: string | null) =>
  isAbsolute(path) || directory === null || directory === "" || path.startsWith(`${directory}/`)
    ? path
    : join(directory, path)

const short = (text: string) => {
  const line = oneLine(text.split("\n")[0])
  return line.length <= SUMMARY_LENGTH ? line : `${line.slice(0, SUMMARY_LENGTH - 1)}…`
}

// A path stays whole, as the row cuts it from the start.
const pathLine = (path: string) => (Bun.stripANSI(path).split("\n")[0] ?? "").replace(/\p{Cc}/gu, " ")

type Command = Item<"commandExecution">

const SINGLE = /^(?:\S*\/)?(?:ba|z)?sh -l?c '((?:[^']|'\\'')*)'$/s
const DOUBLE = /^(?:\S*\/)?(?:ba|z)?sh -l?c "((?:[^"\\]|\\.)*)"$/s

// Codex runs a command as `/bin/zsh -lc '<command>'` (or in double quotes); the row shows the command. One action
// names it as the user wrote it.
function commandOf(item: Command): string {
  const [action, more] = item.commandActions
  if (action && !more) return action.command
  const single = SINGLE.exec(item.command)
  if (single) return (single[1] ?? "").replaceAll(`'\\''`, "'")
  const double = DOUBLE.exec(item.command)
  return double ? (double[1] ?? "").replace(/\\(.)/g, "$1") : item.command
}

function commandKind(item: Command): { kind: ToolKind; title: string } {
  const types = item.commandActions.map((action) => action.type)
  if (types.length > 0 && types.every((type) => type === "read")) return { kind: "read", title: "read" }
  if (types.length > 0 && types.every((type) => type === "listFiles")) return { kind: "search", title: "list" }
  if (types.length > 0 && types.every((type) => type === "search" || type === "listFiles"))
    return { kind: "search", title: "search" }
  return { kind: "shell", title: "shell" }
}

function commandSummary(item: Command, kind: ToolKind): string {
  const { commandActions: actions, cwd } = item
  if (kind === "read")
    return pathLine(actions.map((action) => absolute(action.path ?? action.name ?? "", cwd)).join(", "))
  if (kind === "search") {
    const [action] = actions
    const where = action?.path ? absolute(action.path, cwd) : cwd
    return action?.query ? short(`${action.query} in ${where}`) : pathLine(where)
  }
  return short(commandOf(item))
}

type Change = Item<"fileChange">["changes"][number]

// One change of a patch: add, delete, or update (a move when `move_path` is set).
export function fileOf(change: Change, cwd: string | null): FileChange {
  const path = absolute(change.path, cwd)
  if (change.kind.type === "add")
    return { path, change: "create", movedTo: null, patch: null, before: null, after: change.diff }
  // A deleted file's diff is the whole file it was.
  if (change.kind.type === "delete")
    return { path, change: "delete", movedTo: null, patch: null, before: change.diff, after: null }
  const moved = change.kind.move_path ?? null
  return {
    path,
    change: moved === null ? "update" : "move",
    movedTo: moved === null ? null : absolute(moved, cwd),
    patch: hunksOf(change.diff),
    after: null,
  }
}

const PATCH_KINDS: Record<FileChange["change"], ToolKind> = {
  create: "write",
  update: "edit",
  delete: "delete",
  move: "move",
}

export function patchKind(files: FileChange[]): ToolKind {
  const [first] = files
  const kind = first ? PATCH_KINDS[first.change] : "edit"
  return files.every((file) => PATCH_KINDS[file.change] === kind) ? kind : "edit"
}

// The row shows the first changed file's diff, so it names that file first.
function patchSummary(files: FileChange[]): string {
  const first = files.find((file) => file.patch !== null) ?? files[0]
  if (!first) return ""
  return pathLine(files.length === 1 ? first.path : `${first.path} and ${files.length - 1} more`)
}

const MESSAGES = new Set(["sendInput", "sendMessage", "followupTask"])

function collabCall(item: Item<"collabAgentToolCall">): Call {
  const prompt = item.prompt ?? ""
  const base = { name: item.tool, mcp: null, command: null, agent: null, message: null }
  const input = { prompt: item.prompt ?? null, model: item.model ?? null, agents: item.receiverThreadIds }
  if (item.tool === "spawnAgent") {
    const agent = { name: "agent", task: short(prompt), prompt, type: "", model: item.model ?? "" }
    return { ...base, kind: "agent", title: "agent", input, summary: short(prompt), agent }
  }
  const [to] = item.receiverThreadIds
  if (MESSAGES.has(item.tool) && to !== undefined)
    return { ...base, kind: "message", title: "message", input, summary: short(prompt), message: { to, text: prompt } }
  const count = item.receiverThreadIds.length
  const summary = count === 0 ? "" : count === 1 ? "1 agent" : `${count} agents`
  return { ...base, kind: "other", title: item.tool, input, summary }
}

function other(name: string, input: unknown, summary: string): Call {
  return { name, kind: "other", title: name, mcp: null, input, summary, command: null, agent: null, message: null }
}

// YellowCode's own tools: our ask, which has no namespace, and each mod's tools under the mod's namespace.
function dynamicCall(item: Item<"dynamicToolCall">): Call {
  const { namespace, tool } = item
  if (namespace) {
    const mcp = { server: namespace, tool }
    return { ...other(tool, item.arguments, ""), kind: "mcp", mcp }
  }
  // Our ask's row names its pages, as Claude's does.
  if (tool === ASK) return { ...other(tool, item.arguments, summarizeToolInput(item.arguments)), kind: "question" }
  return other(tool, item.arguments, "")
}

// The call an item makes, as far as it is known yet. `cwd` is the session's folder, for paths Codex gives relative.
export function callOf(item: ToolItem, cwd: string | null): Call {
  const none = { mcp: null, command: null, agent: null, message: null }
  switch (item.type) {
    case "commandExecution": {
      const { kind, title } = commandKind(item)
      const input = { command: item.command, cwd: item.cwd, actions: item.commandActions }
      const command = commandOf(item)
      return { ...none, name: "exec_command", kind, title, input, summary: commandSummary(item, kind), command }
    }
    case "fileChange": {
      const files = item.changes.map((change) => fileOf(change, cwd))
      const kind = patchKind(files)
      return {
        ...none,
        name: "apply_patch",
        kind,
        title: kind,
        input: { changes: item.changes },
        summary: patchSummary(files),
      }
    }
    case "mcpToolCall":
      return {
        ...none,
        name: item.tool,
        kind: "mcp",
        title: item.tool,
        mcp: { server: item.server, tool: item.tool },
        input: item.arguments,
        summary: "",
      }
    case "dynamicToolCall":
      return dynamicCall(item)
    case "collabAgentToolCall":
      return collabCall(item)
    case "webSearch": {
      const query = item.query || searchOf(item.action)
      return {
        ...none,
        name: "web_search",
        kind: "websearch",
        title: "websearch",
        input: { query, action: item.action },
        summary: short(query),
      }
    }
    case "imageView": {
      const path = absolute(item.path, cwd)
      return {
        ...none,
        name: "view_image",
        kind: "read",
        title: "view image",
        input: { path },
        summary: pathLine(path),
      }
    }
    case "imageGeneration":
      return other("image_generation", { prompt: item.revisedPrompt ?? null }, short(item.revisedPrompt ?? ""))
    case "sleep":
      return other("sleep", { durationMs: item.durationMs }, `${item.durationMs} ms`)
    case "functionCallOutput":
      return other(item.name, { namespace: item.namespace ?? null }, "")
    case "hookPrompt":
      break
  }
  return other("hook", { fragments: item.fragments }, short(item.fragments[0]?.text ?? ""))
}

// What a web search's action names: its query, its queries, or the page it opened.
function searchOf(action: unknown): string {
  if (typeof action !== "object" || action === null) return ""
  const found: Record<string, unknown> = { ...action }
  const { query, queries, url } = found
  if (typeof query === "string") return query
  if (Array.isArray(queries)) return queries.filter((one) => typeof one === "string").join(", ")
  return typeof url === "string" ? url : ""
}

export function calledOf(id: ToolId, call: Call): Called {
  return {
    type: "tool.called",
    id,
    kind: call.kind,
    name: call.name,
    title: call.title,
    input: call.input,
    summary: call.summary,
    detail: null,
    command: call.command,
    background: false,
    questions: call.kind === "question" ? questionsOf(OWN_ASK, call.input) : null,
    agent: call.agent,
    message: call.message,
    todos: null,
    at: 0,
  }
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

const DENIED: Ended["outcome"] = { status: "denied", said: "", why: "declined", note: "" }

const MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export const mediaOf = (path: string) => MEDIA[extname(path).toLowerCase()] ?? "image/png"

const lines = (text: string) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length)
const filled = (text: string) => text.split("\n").filter((line) => line.trim() !== "").length

function countOf(kind: ToolKind, title: string, output: string): Ended["count"] {
  if (kind === "read") return { n: lines(output), noun: "line" }
  if (kind === "search") return { n: filled(output), noun: title === "list" ? "file" : "match" }
  return null
}

const textOf = (content: unknown[]) =>
  content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null) return []
      const fields: Record<string, unknown> = { ...part }
      return fields["type"] === "text" && typeof fields["text"] === "string" ? [fields["text"]] : []
    })
    .join("\n")

function imagesOf(content: unknown[]): Image[] {
  return content.flatMap((part, index): Image[] => {
    if (typeof part !== "object" || part === null) return []
    const fields: Record<string, unknown> = { ...part }
    const { type, data, mimeType } = fields
    if (type !== "image" || typeof data !== "string") return []
    const mediaType = typeof mimeType === "string" ? mimeType : "image/png"
    return [{ name: `Image ${index + 1}`, mediaType, data, path: null }]
  })
}

// Codex's own words for how a call went.
const STATUS: Record<string, Ended["status"]> = {
  completed: "done",
  failed: "error",
  declined: "error",
  interrupted: "stopped",
}

// The end of a finished call; `output` is what streamed of a command's output. A spawned subagent's call ends at once
// and its task goes on, so it is told as background work.
export function endOf(item: ToolItem, call: Call, output: string, cwd: string | null): Ended {
  const reported = "status" in item && typeof item.status === "string" ? item.status : "completed"
  const status = STATUS[reported] ?? "done"
  const end = { ...blankEnd(item.id, status, ""), outcome: reported === "declined" ? DENIED : null }
  switch (item.type) {
    case "commandExecution": {
      const result = item.aggregatedOutput ?? output
      const exitCode = item.exitCode ?? null
      const failed = status === "done" && exitCode !== null && exitCode !== 0
      const count = status === "done" && !failed ? countOf(call.kind, call.title, result) : null
      return { ...end, status: failed ? "error" : status, result, exitCode, count }
    }
    case "fileChange": {
      const files = item.changes.map((change) => fileOf(change, cwd))
      const [first] = files
      const created = files.length === 1 && first?.change === "create"
      const patch = files.find((file) => file.patch !== null)?.patch ?? null
      return { ...end, files, patch, created, content: created ? (first?.after ?? null) : null }
    }
    case "mcpToolCall": {
      if (item.error) return { ...end, status: "error", result: item.error.message }
      const content = item.result?.content ?? []
      return { ...end, result: textOf(content), images: imagesOf(content) }
    }
    case "dynamicToolCall": {
      const result = (item.contentItems ?? [])
        .flatMap((part) => (part.text === undefined ? [] : [part.text]))
        .join("\n")
      const ended = item.success === false ? "error" : status
      const outcome = call.kind === "question" ? resultOutcome(item.arguments, ended, result) : end.outcome
      return { ...end, status: ended, result, outcome }
    }
    case "collabAgentToolCall": {
      const said = Object.values(item.agentsStates).flatMap((state) => (state.message ? [state.message] : []))
      const [task] = item.receiverThreadIds
      if (item.tool === "spawnAgent" && status === "done" && task !== undefined)
        return { ...end, background: true, task }
      return { ...end, result: said.join("\n\n") }
    }
    case "imageView": {
      const path = absolute(item.path, cwd)
      return { ...end, images: [{ name: basename(path), mediaType: mediaOf(path), data: null, path }] }
    }
    case "imageGeneration":
      return { ...end, result: item.savedPath ?? "" }
    case "functionCallOutput":
      return { ...end, result: typeof item.output === "string" ? item.output : (JSON.stringify(item.output) ?? "") }
    case "hookPrompt":
      return { ...end, result: item.fragments.map((fragment) => fragment.text).join("\n") }
    case "webSearch":
    case "sleep":
      break
  }
  return end
}
