import { homedir } from "node:os"
import { basename, join } from "node:path"
import { z } from "zod"
import type { TaskId, ToolId } from "../../agent/ids.ts"
import type { FileChange, Image, SubagentCall, ToolKind } from "../../agent/tools.ts"
import { OWN_ASK, OWN_SESSIONS, type ProtocolMessage, type UserBlock } from "../../protocol/messages.ts"
import { oneLine } from "../../session/tool-summary.ts"
import { questionsOf } from "./ask-input.ts"
import { type Draft, imagesOf } from "./draft.ts"
import { resultOutcome } from "./outcome.ts"
import { summarizeToolInput, writtenContent } from "./summary.ts"
import type { Relay } from "./relay.ts"

type Of<T extends ProtocolMessage["type"]> = Extract<ProtocolMessage, { type: T }>
type ResultContent = Extract<UserBlock, { type: "tool_result" }>["content"]

const KINDS = new Map<string, ToolKind>(
  Object.entries({
    Bash: "shell",
    PowerShell: "shell",
    Read: "read",
    Glob: "search",
    Grep: "search",
    Edit: "edit",
    MultiEdit: "edit",
    NotebookEdit: "edit",
    Write: "write",
    WebFetch: "fetch",
    WebSearch: "websearch",
    Agent: "agent",
    SendMessage: "message",
    Workflow: "workflow",
    AskUserQuestion: "question",
    [OWN_ASK]: "question",
    ExitPlanMode: "plan",
    EnterPlanMode: "mode",
    Skill: "skill",
    TodoWrite: "todo",
    TaskCreate: "todo",
    TaskUpdate: "todo",
    TaskList: "todo",
    TaskGet: "todo",
  }),
)

// Monitor takes a command like Bash, but its row stays plain, so it is not kind shell.
const COMMAND_TOOLS = new Set(["Bash", "PowerShell", "Monitor"])

export function mcpOf(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null
  const [server = "", ...rest] = name.slice("mcp__".length).split("__")
  const tool = rest.join("__")
  return server && tool ? { server, tool } : null
}

export const kindOf = (name: string): ToolKind => KINDS.get(name) ?? (mcpOf(name) ? "mcp" : "other")

// Our own ask stands in for the stock one, so it reads like it and names no server.
export const shownMcp = (name: string) => (name === OWN_ASK ? null : mcpOf(name))

export const titleOf = (name: string) => (name === OWN_ASK ? "AskUserQuestion" : (mcpOf(name)?.tool ?? name))

export const field = (input: unknown, key: string): unknown =>
  typeof input === "object" && input !== null ? Reflect.get(input, key) : undefined

export const text = (value: unknown) => (typeof value === "string" ? value : null)

// The file an Edit or Write names, with a leading ~ read as HOME.
export function inputFile(input: unknown): string | null {
  const file = text(field(input, "file_path")) ?? text(field(input, "notebook_path"))
  if (file === "~") return homedir()
  return file?.startsWith("~/") ? join(homedir(), file.slice(2)) : file
}

const agentFields = z.looseObject({
  name: z.string().optional(),
  subagent_type: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
})

function subagentOf(kind: ToolKind, input: unknown): SubagentCall | null {
  if (kind !== "agent") return null
  const parsed = agentFields.safeParse(input)
  if (!parsed.success) return null
  return {
    name: oneLine(parsed.data.name) || oneLine(parsed.data.subagent_type) || "agent",
    task: parsed.data.description ?? "",
    prompt: parsed.data.prompt ?? "",
    type: parsed.data.subagent_type ?? "",
    model: parsed.data.model ?? "",
  }
}

const messageFields = z.looseObject({ to: z.string().optional(), message: z.string().optional() })

function messageOf(kind: ToolKind, input: unknown): { to: TaskId; text: string } | null {
  if (kind !== "message") return null
  const parsed = messageFields.safeParse(input)
  return parsed.success && parsed.data.to ? { to: parsed.data.to, text: parsed.data.message ?? "" } : null
}

function resultText(content: ResultContent): string {
  if (content === undefined) return ""
  const joined =
    typeof content === "string"
      ? content
      : content
          .flatMap((block) =>
            block.type === "text" ? [block.text] : block.type === "image" ? [] : [`[${block.originalType}]`],
          )
          .join("\n")
  return Bun.stripANSI(joined)
}

// A Read names its images after the file.
function resultImages(name: string | undefined, input: unknown, content: ResultContent): Image[] {
  if (content === undefined || typeof content === "string") return []
  const path = name === "Read" ? text(field(input, "file_path")) : null
  return imagesOf(content, path ? () => basename(path) : (index) => `Image ${index + 1}`, path)
}

// Read numbers each line it gives back; Glob gives one path a line.
function countOf(name: string | undefined, result: string): Extract<Draft, { type: "tool.end" }>["count"] {
  const lines = result.split("\n").filter((line) => line.trim() !== "")
  if (name === "Read") {
    const numbered = lines.filter((line) => /^\s*\d+\t/.test(line))
    // The file's last newline comes back as a numbered empty line.
    const last = numbered.at(-1)
    return { n: numbered.length - (last !== undefined && /^\s*\d+\t$/.test(last) ? 1 : 0), noun: "line" }
  }
  if (name === "Glob") return { n: lines.length, noun: "file" }
  return null
}

type Call = { name: string; kind: ToolKind; parent: ToolId | null; input: unknown }

const OWN_TOOLS = OWN_SESSIONS.slice(0, OWN_SESSIONS.lastIndexOf("__") + 2)

// Loading YellowCode's own session tools is a step of sending a message, not a call of its own.
function loadsOwnTools(input: unknown): boolean {
  const query = text(field(input, "query"))
  if (!query?.startsWith("select:")) return false
  const names = query.slice("select:".length).split(",")
  return names.every((name) => name.trim().startsWith(OWN_TOOLS))
}

// Tool calls from stream events, assistant lines and tool results. Calls are kept by id for the whole conversation,
// so a result can be read by its call's name and input.
export function createTools(relay: Relay) {
  const calls = new Map<ToolId, Call>()
  // Searches kept out of the chat until their input says what they load.
  const searches = new Set<ToolId>()

  function start(id: ToolId, parent: ToolId | null, name: string): Draft[] {
    const kind = kindOf(name)
    calls.set(id, { name, kind, parent, input: undefined })
    const relayed = parent === null && relay.tool(id, name)
    const searching = parent === null && !relayed && name === "ToolSearch"
    if (searching) searches.add(id)
    const quiet = relayed || searching
    return [{ type: "tool.start", id, parent, name, kind, title: titleOf(name), mcp: shownMcp(name), quiet }]
  }

  // An assistant line's tool_use block: the call's whole input. A call that did not stream starts here.
  function called(block: { id: ToolId; name: string; input: unknown }, parent: ToolId | null): Draft[] {
    const out = calls.has(block.id) ? [] : start(block.id, parent, block.name)
    const call = calls.get(block.id)
    if (call) call.input = block.input
    const input = block.input
    const kind = call?.kind ?? "other"
    const commanded = COMMAND_TOOLS.has(block.name)
    out.push({
      type: "tool.called",
      id: block.id,
      kind: null,
      name: null,
      title: null,
      mcp: null,
      input,
      summary: summarizeToolInput(input),
      detail: commanded ? text(field(input, "description")) : null,
      command: commanded ? text(field(input, "command")) : null,
      background: field(input, "run_in_background") === true,
      questions: kind === "question" ? questionsOf(block.name, input) : null,
      agent: subagentOf(kind, input),
      message: messageOf(kind, input),
      todos: null,
    })
    if (searches.delete(block.id) && !loadsOwnTools(input)) out.push({ type: "shown", parts: [], tools: [block.id] })
    out.push(...relay.called(block.id, input))
    return out
  }

  function results(message: Of<"user">): Draft[] {
    const content = message.message.content
    if (message.isReplay || typeof content === "string") return []
    const fileResult = message.tool_use_result
    const main = !message.parent_tool_use_id
    const out: Draft[] = []
    for (const block of content) {
      if (block.type !== "tool_result") continue
      const id = block.tool_use_id
      const call = calls.get(id)
      const result = resultText(block.content)
      if (call?.name === "SendMessage") out.push(...relay.settle(call.input, block.is_error === true, result))
      const skipped = message.tool_result_meta?.find((meta) => meta.id === id)?.non_execution_kind
      const stopped = skipped === "user-rejected" || skipped === "interrupted"
      const status = stopped ? "stopped" : block.is_error ? "error" : "done"
      // A subagent's lines carry no tool_use_result; Write's own reply says whether it made the file.
      const created =
        fileResult?.type === "create" ||
        (!fileResult && call?.name === "Write" && result.startsWith("File created successfully"))
      const written = call?.name === "Write" ? writtenContent(call.input) : null
      const patch = fileResult?.structuredPatch ?? null
      const files: FileChange[] = []
      // What an Edit or Write found in its file is only told on the main thread.
      const before = main ? fileResult?.originalFile : undefined
      const writes = call?.kind === "edit" || call?.kind === "write"
      const path = inputFile(call?.input) ?? fileResult?.filePath
      if (path && ((writes && status === "done") || before !== undefined))
        files.push({
          path,
          // Not from `before`: claude leaves originalFile null on many edits of a file that was there.
          change: created ? "create" : "update",
          movedTo: null,
          patch,
          ...(before === undefined ? {} : { before }),
          after: written,
        })
      out.push({
        type: "tool.end",
        id,
        status,
        result,
        images: resultImages(call?.name, call?.input, block.content),
        patch,
        created,
        content: written,
        unchanged: fileResult?.type === "file_unchanged",
        exitCode: null,
        count: status === "done" ? countOf(call?.name, result) : null,
        outcome: call?.kind === "question" ? resultOutcome(call.input, status, result) : null,
        background: fileResult?.isAsync === true,
        task: call?.kind === "agent" ? (fileResult?.agentId ?? null) : null,
        files,
      })
      // Only a result reads the input; a Write's can be a whole file.
      if (call) call.input = undefined
    }
    return out
  }

  // The call a tool call runs under; undefined for a call not seen.
  const parentOf = (id: ToolId) => calls.get(id)?.parent
  const callKind = (id: ToolId) => calls.get(id)?.kind

  return { start, called, results, parentOf, callKind }
}

export type Tools = ReturnType<typeof createTools>
