// Pi's tools as neutral calls: the kind, the row's name and summary, and what a finished call wrote, ran or found.
// Built-in tools are read, bash, edit, write, grep, find and ls; any other is an extension's.
import { isAbsolute, join } from "node:path"
import type { AgentEvent } from "../../agent/events.ts"
import type { ToolId } from "../../agent/ids.ts"
import type { FileChange, ToolKind } from "../../agent/tools.ts"
import { oneLine, SUMMARY_LENGTH } from "../../session/tool-summary.ts"
import { hunksOf } from "../hunks.ts"
import type { Part, ToolResult } from "./wire.ts"

type Called = Extract<AgentEvent, { type: "tool.called" }>
type Ended = Extract<AgentEvent, { type: "tool.end" }>

const KINDS: Record<string, ToolKind> = {
  bash: "shell",
  read: "read",
  edit: "edit",
  write: "write",
  grep: "search",
  find: "search",
  ls: "search",
}

// Pi names an MCP tool `mcp__<server>__<tool>`, with the server's `-` as `_`.
export function mcpOf(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null
  const rest = name.slice("mcp__".length)
  const split = rest.indexOf("__")
  return split > 0 && split < rest.length - 2 ? { server: rest.slice(0, split), tool: rest.slice(split + 2) } : null
}

export const kindOf = (name: string): ToolKind => KINDS[name] ?? (mcpOf(name) ? "mcp" : "other")

// What a call's row shows: an MCP tool's own name with its server, or the tool's name.
export function labelOf(name: string): { title: string; mcp: { server: string; tool: string } | null } {
  const mcp = mcpOf(name)
  return { title: mcp?.tool ?? name, mcp }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const field = (input: unknown, key: string): string | null => {
  const value = isRecord(input) ? input[key] : undefined
  return typeof value === "string" ? value : null
}

const short = (text: string) => {
  const line = oneLine(text.split("\n")[0])
  return line.length <= SUMMARY_LENGTH ? line : `${line.slice(0, SUMMARY_LENGTH - 1)}…`
}

// A recording's paths start with its `<root>` placeholder, which is not absolute, so a path already in the folder
// stays as it is.
export const absolute = (path: string, cwd: string) =>
  isAbsolute(path) || cwd === "" || path.startsWith(`${cwd}/`) ? path : join(cwd, path)

function summaryOf(name: string, input: unknown): string {
  const command = field(input, "command")
  if (name === "bash" && command !== null) return short(command)
  const path = field(input, "path")
  const pattern = field(input, "pattern")
  if (pattern !== null) return short(path === null ? pattern : `${pattern} in ${path}`)
  if (path !== null) return short(path)
  return ""
}

export function calledOf(id: ToolId, name: string, input: unknown, at: number): Called {
  return {
    type: "tool.called",
    id,
    kind: kindOf(name),
    name,
    ...labelOf(name),
    input,
    summary: summaryOf(name, input),
    detail: null,
    command: name === "bash" ? field(input, "command") : null,
    background: false,
    questions: null,
    agent: null,
    message: null,
    todos: null,
    at,
  }
}

export const textOf = (content: Part[] | undefined): string =>
  (content ?? []).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n")

const lines = (text: string) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length)

function exitCodeOf(result: ToolResult | undefined): number | null {
  const code = isRecord(result?.structuredContent) ? result.structuredContent["exit_code"] : undefined
  return typeof code === "number" ? code : null
}

function patchOf(result: ToolResult | undefined): string | null {
  const patch = isRecord(result?.details) ? result.details["patch"] : undefined
  return typeof patch === "string" ? patch : null
}

export function endOf(
  id: ToolId,
  name: string,
  input: unknown,
  result: ToolResult | undefined,
  error: boolean,
  cwd: string,
  at: number,
  // The file a write names was not there before the call; null when that is not known, which counts as an update.
  created: boolean | null = null,
): Ended {
  const output = textOf(result?.content)
  const kind = kindOf(name)
  const patch = kind === "edit" ? patchOf(result) : null
  const hunks = patch === null ? null : hunksOf(patch)
  const path = field(input, "path")
  const content = kind === "write" ? field(input, "content") : null
  const files: FileChange[] =
    error || path === null || (kind !== "edit" && kind !== "write")
      ? []
      : [
          {
            path: absolute(path, cwd),
            change: kind === "write" && created === true ? "create" : "update",
            movedTo: null,
            patch: hunks,
            after: content,
          },
        ]
  return {
    type: "tool.end",
    id,
    status: error ? "error" : "done",
    result: output,
    images: [],
    patch: hunks,
    created: kind === "write" && created === true,
    content,
    unchanged: false,
    exitCode: exitCodeOf(result),
    count: kind === "read" && !error ? { n: lines(output), noun: "line" } : null,
    outcome: null,
    background: false,
    task: null,
    files,
    at,
  }
}
