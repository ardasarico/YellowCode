import { z } from "zod"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
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

export function toEvent(entry: Entry): SourceEvent | null {
  const at = entry.timestamp === undefined ? 0 : Date.parse(entry.timestamp)
  const event = (dir: "in" | "out", message: object): SourceEvent => ({ dir, line: JSON.stringify(message), at })

  if (entry.type === "assistant" && entry.message) {
    return event("in", { type: "assistant", parent_tool_use_id: null, message: entry.message })
  }
  if (isCompactBoundary(entry)) {
    const trigger = entry.compactMetadata?.trigger ?? "manual"
    return event("in", { type: "system", subtype: "compact_boundary", compact_metadata: { trigger } })
  }
  const content = entry.message?.content
  if (entry.type !== "user" || content === undefined || entry.isMeta || entry.isCompactSummary) return null
  if (typeof content !== "string" && content.some((block) => block.type === "tool_result")) {
    return event("in", {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content },
      tool_use_result: entry.toolUseResult,
    })
  }
  if (entry.isVisibleInTranscriptOnly) return null
  const text = typeof content === "string" ? content : (content.find((block) => block.type === "text")?.text ?? "")
  if (text.startsWith("<local-command-stdout>")) return null
  const prompt = typeof content === "string" ? commandPrompt(content) : content
  return event("out", { type: "user", parent_tool_use_id: null, message: { role: "user", content: prompt } })
}

function isCompactCommand(event: SourceEvent | null): boolean {
  return event?.dir === "out" && event.line.includes('"content":"/compact')
}

export async function readTranscript(path: string, cursor?: TranscriptCursor): Promise<TranscriptPart> {
  const events: SourceEvent[] = []
  let wanted = cursor?.wanted ?? null
  let prompts = 0
  for await (const { line, offset } of readLinesBackward(path, cursor?.offset ?? Bun.file(path).size)) {
    const entry = wanted === null ? leafEntry(line) : wantedEntry(line, wanted)
    if (entry === null) continue
    const event = toEvent(entry)
    // The file writes the boundary before the `/compact` prompt that caused it; the divider belongs after it.
    if (event && isCompactBoundary(entry) && isCompactCommand(events.at(-1) ?? null)) {
      events.splice(-1, 0, event)
    } else if (event) events.push(event)
    wanted = (isCompactBoundary(entry) ? entry.logicalParentUuid : entry.parentUuid) ?? null
    if (wanted === null) return { events: events.toReversed(), earlier: null }
    if (event?.dir === "out" && ++prompts >= PART_TURNS && !isCompactCommand(event)) {
      return { events: events.toReversed(), earlier: { offset, wanted } }
    }
  }
  log.warn("transcript chain is broken", { path, wanted })
  return { events: events.toReversed(), earlier: null }
}

export function loadTranscript(session: SessionStore, part: TranscriptPart): void {
  for (const event of part.events) session.apply(event.dir, parse(event.line), event.at)
  session.stopRunning()
  session.end()
}
