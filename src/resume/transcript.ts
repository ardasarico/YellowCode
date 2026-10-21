import { z } from "zod"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import { interruptRequest } from "../protocol/outgoing.ts"
import { parse } from "../protocol/parse.ts"
import type { SessionStore } from "../session/session.ts"
import type { SourceEvent } from "../source/source.ts"
import { readLinesBackward } from "./reverse-lines.ts"
import { CHAIN_TYPES, commandPrompt } from "./session-list.ts"

export const PART_TURNS = 20

export type TranscriptCursor = { offset: number; wanted: string }
export type TranscriptPart = { events: SourceEvent[]; earlier: TranscriptCursor | null }

const Block = z.looseObject({ type: z.string(), text: z.string().optional() })

const Entry = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  logicalParentUuid: z.string().nullable().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  isVisibleInTranscriptOnly: z.boolean().optional(),
  timestamp: z.string().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(Block)]).optional() }).optional(),
  toolUseResult: z.unknown().optional(),
  compactMetadata: z.looseObject({ trigger: z.string().optional() }).optional(),
})

type Entry = z.infer<typeof Entry>

function parseEntry(line: string): Entry | null {
  const json = parseJson(line)
  const entry = json.ok ? Entry.safeParse(json.value) : null
  return entry?.success ? entry.data : null
}

function leafEntry(line: string): Entry | null {
  if (!line.includes('"uuid":"')) return null
  const entry = parseEntry(line)
  return entry?.uuid !== undefined && CHAIN_TYPES.has(entry.type) && !entry.isSidechain ? entry : null
}

function wantedEntry(line: string, wanted: string): Entry | null {
  if (!line.includes(`"uuid":"${wanted}"`)) return null
  const entry = parseEntry(line)
  return entry?.uuid === wanted ? entry : null
}

function isCompactBoundary(entry: Entry): boolean {
  return entry.type === "system" && entry.subtype === "compact_boundary"
}

// Where claude noted that the user interrupted the turn; it becomes the interrupt and result of a live turn once the
// part is read, since the turn's start is known only then.
const INTERRUPTED = JSON.stringify({ interrupted: true })
// claude starts a turn of its own after a background task's end.
const REQUESTING = JSON.stringify({ type: "system", subtype: "status", status: "requesting" })
const ENDS: Record<string, string> = { completed: "completed", failed: "failed", stopped: "stopped", killed: "stopped" }

// claude's note that a background task ended (its own turn's message, not the user's): it ends the task's call.
function notification(text: string, at: number): SourceEvent[] {
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim()
  const status = ENDS[tag("status") ?? ""]
  const toolUseId = tag("tool-use-id")
  const taskId = tag("task-id") ?? toolUseId
  const ended =
    status && taskId
      ? [
          {
            type: "system",
            subtype: "task_notification",
            task_id: taskId,
            tool_use_id: toolUseId,
            status,
            summary: tag("summary") ?? "",
          },
        ]
      : []
  return [
    ...ended.map((message) => ({ dir: "in" as const, line: JSON.stringify(message), at })),
    { dir: "in", line: REQUESTING, at },
  ]
}

// The events of one transcript entry, in order.
export function toEvents(entry: Entry): SourceEvent[] {
  const at = entry.timestamp === undefined ? 0 : Date.parse(entry.timestamp)
  const event = (dir: "in" | "out", message: object): SourceEvent => ({ dir, line: JSON.stringify(message), at })

  if (entry.type === "assistant" && entry.message) {
    return [event("in", { type: "assistant", parent_tool_use_id: null, message: entry.message })]
  }
  if (isCompactBoundary(entry)) {
    const trigger = entry.compactMetadata?.trigger ?? "manual"
    return [event("in", { type: "system", subtype: "compact_boundary", compact_metadata: { trigger } })]
  }
  const content = entry.message?.content
  if (entry.type !== "user" || content === undefined || entry.isMeta || entry.isCompactSummary) return []
  if (typeof content !== "string" && content.some((block) => block.type === "tool_result")) {
    return [
      event("in", {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content },
        tool_use_result: entry.toolUseResult,
      }),
    ]
  }
  if (entry.isVisibleInTranscriptOnly) return []
  const text = typeof content === "string" ? content : (content.find((block) => block.type === "text")?.text ?? "")
  if (text.startsWith("<local-command-stdout>")) return []
  if (text.startsWith("<task-notification>")) return notification(text, at)
  if (text.startsWith("[Request interrupted by user")) return [{ dir: "in", line: INTERRUPTED, at }]
  const prompt = typeof content === "string" ? commandPrompt(content) : content
  return [event("out", { type: "user", parent_tool_use_id: null, message: { role: "user", content: prompt } })]
}

// An interrupted turn ends as a live one does: the interrupt goes out and its result comes back, after as long as
// the turn ran.
function interrupts(events: SourceEvent[]): SourceEvent[] {
  let started = 0
  return events.flatMap((event): SourceEvent[] => {
    if (event.line !== INTERRUPTED) {
      if (event.dir === "out" || event.line === REQUESTING) started = event.at
      return [event]
    }
    const result = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      total_cost_usd: 0,
      duration_ms: started > 0 ? Math.max(0, event.at - started) : 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    }
    return [
      { dir: "out", line: interruptRequest("history"), at: event.at },
      { dir: "in", line: JSON.stringify(result), at: event.at },
    ]
  })
}

// claude leaves the tool-use-id out of a later note on the same task; an earlier one names the call. A note whose
// call stays unknown is dropped.
const Note = z.looseObject({
  subtype: z.literal("task_notification"),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
})

function namedNotes(events: SourceEvent[]): SourceEvent[] {
  const calls = new Map<string, string>()
  return events.flatMap((event): SourceEvent[] => {
    if (event.dir !== "in" || !event.line.includes('"subtype":"task_notification"')) return [event]
    const json = parseJson(event.line)
    const note = json.ok ? Note.safeParse(json.value).data : undefined
    if (!note) return [event]
    const toolUseId = note.tool_use_id ?? calls.get(note.task_id)
    if (toolUseId === undefined) return []
    calls.set(note.task_id, toolUseId)
    return [{ ...event, line: JSON.stringify({ ...note, tool_use_id: toolUseId }) }]
  })
}

// Both passes need the part in order, oldest first.
const inOrder = (events: SourceEvent[]) => interrupts(namedNotes(events.toReversed()))

function isCompactCommand(event: SourceEvent | undefined): boolean {
  return event?.dir === "out" && event.line.includes('"content":"/compact')
}

function entryText(entry: Entry): string {
  const content = entry.message?.content
  if (typeof content === "string") return content
  return content?.find((block) => block.type === "text")?.text ?? ""
}

// What a command claude ran itself printed (/model, /context, a set_model after a turn); its parent is the command.
function isCommandOutput(entry: Entry): boolean {
  if (entry.type === "system") return entry.subtype === "local_command"
  return entry.type === "user" && entryText(entry).startsWith("<local-command-stdout>")
}

export async function readTranscript(path: string, cursor?: TranscriptCursor): Promise<TranscriptPart> {
  const events: SourceEvent[] = []
  let wanted = cursor?.wanted ?? null
  let prompts = 0
  // The entry walked before this one was the output of a command claude ran itself.
  let afterOutput = false
  for await (const { line, offset } of readLinesBackward(path, cursor?.offset ?? Bun.file(path).size)) {
    const entry = wanted === null ? leafEntry(line) : wantedEntry(line, wanted)
    if (entry === null) continue
    const mapped = toEvents(entry)
    // Such a command is no message of the user's (a set_model after a turn writes one too), and its output is
    // dropped already, so the history drops both; /compact keeps its row before the divider.
    const dropped = afterOutput && entryText(entry).includes("<command-name>") && !isCompactCommand(mapped[0])
    const taken = dropped ? [] : mapped
    afterOutput = isCommandOutput(entry)
    // The file writes the boundary before the `/compact` prompt that caused it; the divider belongs after it.
    if (taken.length > 0 && isCompactBoundary(entry) && isCompactCommand(events.at(-1))) {
      events.splice(-1, 0, ...taken)
    } else events.push(...taken.toReversed())
    wanted = (isCompactBoundary(entry) ? entry.logicalParentUuid : entry.parentUuid) ?? null
    if (wanted === null) return { events: inOrder(events), earlier: null }
    const prompt = taken.find((event) => event.dir === "out")
    if (prompt && ++prompts >= PART_TURNS && !isCompactCommand(prompt)) {
      return { events: inOrder(events), earlier: { offset, wanted } }
    }
  }
  log.warn("transcript chain is broken", { path, wanted })
  return { events: inOrder(events), earlier: null }
}

export function loadTranscript(session: SessionStore, part: TranscriptPart): void {
  for (const event of part.events) session.apply(event.dir, parse(event.line), event.at)
  session.stopRunning()
  session.end()
}
