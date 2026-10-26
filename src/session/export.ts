import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { patchCounts, shownItems } from "./rewind.ts"
import type { Hunk, Session, ToolCall } from "./types.ts"

function changeCounts(patch: Hunk[]): string {
  const { plus, minus } = patchCounts(patch)
  return plus + minus > 0 ? ` +${plus} −${minus}` : ""
}

function toolLine(tool: ToolCall, cwd: string): string {
  const summary = cwd && tool.summary.startsWith(`${cwd}/`) ? tool.summary.slice(cwd.length + 1) : tool.summary
  const call = summary ? `${tool.name}(${summary})` : tool.name
  const counts = tool.patch ? changeCounts(tool.patch) : ""
  const failed = tool.status === "error" ? " · failed" : ""
  return `- ${call}${counts}${failed}`
}

// The shown conversation as Markdown: the user's messages, Claude's replies and one line per tool call. Thinking,
// tool output and quiet lines stay out.
export function conversationMarkdown(
  session: Session,
  meta: { title: string; model: string; cwd: string; date: Date },
): string {
  const { title, model, cwd, date } = meta
  const day = date.toISOString().slice(0, 10)
  const parts = [`# ${title}`, `Exported from YellowCode on ${day}${model ? ` · ${model}` : ""}`]
  let speaker: "you" | "claude" | null = null
  let tools: string[] = []
  const flushTools = () => {
    if (tools.length > 0) parts.push(tools.join("\n"))
    tools = []
  }
  const say = (who: "you" | "claude") => {
    flushTools()
    if (speaker !== who) parts.push(who === "you" ? "## You" : "## Claude")
    speaker = who
  }
  for (const id of shownItems(session.items, session.rewound)) {
    const item = session.byId[id]
    if (item?.kind === "user") {
      say("you")
      parts.push(item.to ? `To @${item.to.name}: ${item.text}` : item.text)
    } else if (item?.kind === "text" && !item.quiet && item.markdown.trim()) {
      say("claude")
      parts.push(item.markdown.trim())
    } else if (item?.kind === "tool" && item.local) {
      say("you")
      parts.push(`! ${item.summary}`)
    } else if (item?.kind === "tool" && !item.quiet) {
      if (speaker !== "claude") say("claude")
      tools.push(toolLine(item, cwd))
    }
  }
  flushTools()
  return `${parts.join("\n\n")}\n`
}

export function exportFileName(title: string, date: Date): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return `${slug || "conversation"}-${date.toISOString().slice(0, 10)}.md`
}

// The name, or the first `<stem>-<n><ext>` from 2 on that no file in `cwd` has.
export function freeExportName(cwd: string, name: string): string {
  const dot = name.lastIndexOf(".")
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""]
  let free = name
  for (let n = 2; existsSync(resolve(cwd, free)); n++) free = `${stem}-${n}${ext}`
  return free
}
