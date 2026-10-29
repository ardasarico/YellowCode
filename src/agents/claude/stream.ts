import type { PartId, ToolId } from "../../agent/ids.ts"
import type { ProtocolMessage } from "../../protocol/messages.ts"
import { type Draft, textOf } from "./draft.ts"
import type { Relay } from "./relay.ts"
import type { Tasks } from "./tasks.ts"
import type { Tools } from "./tools.ts"

type Of<T extends ProtocolMessage["type"]> = Extract<ProtocolMessage, { type: T }>
type Block = { kind: "text" | "thinking"; part: PartId } | { kind: "tool"; id: ToolId }
// The blocks of the message a thread streams now, by index. Its `assistant` lines repeat the last one whole.
type Cursor = { message: string; blocks: Map<number, Block>; last: number; finalized: Set<number> }

// Text, thinking and tool calls from stream events and assistant lines. A thread's cursor is keyed by the parent its
// lines name; what it emits names the call the thread runs under now.
export function createStream(tools: Tools, relay: Relay, tasks: Tasks) {
  const cursors = new Map<ToolId | null, Cursor>()
  const open = new Set<PartId>()
  // claude's own replies to local commands (/context, /model) seen so far; a compaction prints one again.
  const localReplies = new Set<string>()
  let parts = 0

  const quietText = (part: PartId, parent: ToolId | null) => parent === null && relay.text(part)

  function end(block: Extract<Block, { part: PartId }>, text: string | null): Draft {
    open.delete(block.part)
    return { type: block.kind === "text" ? "text.end" : "thinking.end", part: block.part, text }
  }

  function endOpen(cursor: Cursor): Draft[] {
    const ends: Draft[] = []
    for (const block of cursor.blocks.values())
      if (block.kind !== "tool" && open.has(block.part)) ends.push(end(block, null))
    return ends
  }

  function streamEvent(message: Of<"stream_event">): Draft[] {
    const thread = message.parent_tool_use_id
    const parent = tasks.current(thread)
    const cursor = cursors.get(thread)
    const event = message.event
    switch (event.type) {
      case "message_start": {
        const ends = cursor ? endOpen(cursor) : []
        cursors.set(thread, { message: event.message.id, blocks: new Map(), last: -1, finalized: new Set() })
        return [...ends, { type: "reply" }]
      }
      case "content_block_start": {
        const block = event.content_block
        if (!cursor || block.type === "unknown") return []
        cursor.last = event.index
        if (block.type === "tool_use") {
          cursor.blocks.set(event.index, { kind: "tool", id: block.id })
          return tools.start(block.id, parent, block.name)
        }
        const part = `part-${++parts}`
        open.add(part)
        cursor.blocks.set(event.index, { kind: block.type, part })
        return block.type === "text"
          ? [{ type: "text.start", part, parent, text: block.text, local: false, quiet: quietText(part, parent) }]
          : [{ type: "thinking.start", part, parent, text: block.thinking, live: true }]
      }
      case "content_block_delta": {
        const block = cursor?.blocks.get(event.index)
        const delta = event.delta
        if (block?.kind === "text" && delta.type === "text_delta")
          return [{ type: "text.delta", part: block.part, text: delta.text }]
        if (block?.kind === "thinking" && delta.type === "thinking_delta")
          return [{ type: "thinking.delta", part: block.part, text: delta.thinking }]
        if (block?.kind === "tool" && delta.type === "input_json_delta")
          return [{ type: "tool.input.delta", id: block.id, text: delta.partial_json }]
        return []
      }
      case "content_block_stop": {
        const block = cursor?.blocks.get(event.index)
        return block && block.kind !== "tool" && open.has(block.part) ? [end(block, null)] : []
      }
      case "unknown":
        break
    }
    return []
  }

  function assistant(message: Of<"assistant">): Draft[] {
    const local = message.message.model === "<synthetic>"
    if (local && message.uuid) {
      if (localReplies.has(message.uuid)) return []
      localReplies.add(message.uuid)
    }
    // A local command that failed (a compaction the API refused) says why in a reply of its own.
    if (message.local_command_outcome?.kind === "failed") {
      const text = textOf(message.message.content)
      return text.trim() ? [{ type: "notice", level: "warning", text }] : []
    }
    const thread = message.parent_tool_use_id ?? null
    const parent = tasks.current(thread)
    const out: Draft[] = [{ type: "reply" }]
    const usage = message.message.usage
    if (usage && !parent && !local) {
      const tokens =
        usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
      out.push({ type: "context.used", tokens })
    }
    const model = message.message.model
    if (parent && model) out.push({ type: "subagent.model", call: parent, model })
    for (const block of message.message.content) {
      if (block.type === "tool_use") out.push(...tools.called(block, parent))
      if (block.type !== "text" && block.type !== "thinking") continue
      const text = block.type === "text" ? block.text : block.thinking
      // An empty thinking block keeps what streamed.
      const final = block.type === "thinking" && !text ? null : text
      const cursor = cursors.get(thread)
      const streamed =
        cursor && cursor.message === message.message.id && !cursor.finalized.has(cursor.last)
          ? cursor.blocks.get(cursor.last)
          : undefined
      if (cursor && streamed && streamed.kind === block.type) {
        cursor.finalized.add(cursor.last)
        out.push(end(streamed, final))
        if (block.type === "text") out.push(...relay.textEnd(streamed.part, text))
        continue
      }
      // A blank text block would only add an empty row.
      if (block.type === "text" && !text.trim()) continue
      const part = `part-${++parts}`
      if (block.type === "text")
        out.push(
          { type: "text.start", part, parent, text, local, quiet: quietText(part, parent) },
          { type: "text.end", part, text },
          ...relay.textEnd(part, text),
        )
      else
        out.push(
          { type: "thinking.start", part, parent, text, live: false },
          { type: "thinking.end", part, text: final },
        )
    }
    return out
  }

  function localOutput(content: string): Draft[] {
    const part = `part-${++parts}`
    return [
      { type: "text.start", part, parent: null, text: content, local: true, quiet: relay.text(part) },
      { type: "text.end", part, text: null },
    ]
  }

  // A turn's end closes every part still streaming.
  function finish(): Draft[] {
    const ends = [...cursors.values()].flatMap(endOpen)
    cursors.clear()
    return ends
  }

  // A /clear drops the main thread's parts; subagents that go on keep streaming theirs.
  function reset(): void {
    const main = cursors.get(null)
    for (const block of main?.blocks.values() ?? []) if (block.kind !== "tool") open.delete(block.part)
    cursors.delete(null)
  }

  function stop(): void {
    cursors.clear()
    open.clear()
  }

  return { streamEvent, assistant, localOutput, finish, reset, stop }
}
