import { createStore, produce } from "solid-js/store"
import type { ContentBlock, PermissionUpdate, ProtocolMessage, UserBlock } from "../protocol/messages.ts"
import type { ParseResult } from "../protocol/parse.ts"
import { agentOf, summarizeToolInput } from "./tool-summary.ts"
import type { Agent, Item, ItemId, Session, UserImage, Window } from "./types.ts"

export type SessionStore = {
  state: Session
  apply(dir: "in" | "out", parsed: ParseResult, at: number): void
  end(): void
}

type Of<T extends ProtocolMessage["type"]> = Extract<ProtocolMessage, { type: T }>

type Cursor = { messageId: string; blocks: Map<number, ItemId>; lastIndex: number; finalized: Set<number> }

const MAIN = "main"

function describeUserContent(content: string | UserBlock[]): { text: string; images: UserImage[] } {
  if (typeof content === "string") return { text: content, images: [] }
  const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
  const images = content.flatMap((block) =>
    block.type === "image" && block.source.data
      ? [{ mediaType: block.source.media_type ?? "image/png", data: block.source.data }]
      : [],
  )
  return { text, images }
}

function toolResultText(content: string | { type: string; text?: string }[] | undefined): string {
  if (content === undefined) return ""
  if (typeof content === "string") return content
  return content.map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`)).join("\n")
}

function firstSuggestion(suggestions: PermissionUpdate[] | undefined): PermissionUpdate | null {
  return suggestions?.find((update) => !(update.type === "setMode" && update.mode === "auto")) ?? null
}

function notesOf(annotations: Record<string, { notes?: string }> | undefined): Record<string, string> {
  const notes: Record<string, string> = {}
  for (const [question, annotation] of Object.entries(annotations ?? {})) {
    if (annotation.notes) notes[question] = annotation.notes
  }
  return notes
}

export function createSession(): SessionStore {
  const [state, setState] = createStore<Session>({
    info: null,
    status: "idle",
    items: [],
    byId: {},
    usage: {
      startedAt: null,
      tokens: 0,
      costUsd: 0,
      context: { used: 0, window: null },
      limits: { fiveHour: null, week: null, models: {} },
      warning: null,
    },
  })
  const cursors = new Map<string, Cursor>()
  const invalid = new Map<string, { id: ItemId; count: number }>()
  let counter = 0
  let interruptSent = false
  let now = 0
  // Recorded times are shifted by this much so a replay reads them as if they happened just now.
  let shift = 0
  const taskTools = new Map<string, ItemId>()
  const newId = (prefix: string): ItemId => `${prefix}-${++counter}`

  function add(item: Item, parent: string | null | undefined): void {
    setState("byId", item.id, item)
    const parentItem = parent ? state.byId[parent] : undefined
    if (parentItem?.kind === "tool") {
      update(parentItem.id, (tool) => {
        if (tool.kind === "tool") tool.children.push(item.id)
      })
    } else {
      setState(
        "items",
        produce((ids) => {
          ids.push(item.id)
        }),
      )
    }
  }

  function update(id: ItemId, change: (item: Item) => void): void {
    if (state.byId[id]) setState("byId", id, produce(change))
  }

  function startedItem(block: ContentBlock): Item | null {
    switch (block.type) {
      case "text":
        return { kind: "text", id: newId("text"), markdown: block.text, streaming: true }
      case "thinking":
        return { kind: "thinking", id: newId("thinking"), text: block.thinking, streaming: true }
      case "tool_use":
        return {
          kind: "tool",
          id: block.id,
          name: block.name,
          inputText: "",
          input: undefined,
          summary: "",
          status: "running",
          result: "",
          children: [],
          patch: null,
          createdFile: false,
          agent: null,
        }
      case "unknown":
        return null
      default:
        return null
    }
  }

  function finalize(id: ItemId, block: ContentBlock): void {
    update(id, (item) => {
      if (item.kind === "text" && block.type === "text") {
        item.markdown = block.text
        item.streaming = false
      } else if (item.kind === "thinking" && block.type === "thinking") {
        if (block.thinking) item.text = block.thinking
        item.streaming = false
      } else if (item.kind === "tool" && block.type === "tool_use") {
        item.input = block.input
        item.inputText = JSON.stringify(block.input)
        item.summary = summarizeToolInput(block.input)
        item.agent = agentOf(item.name, block.input)
      }
    })
  }

  function stopStreaming(id: ItemId): void {
    update(id, (item) => {
      if (item.kind === "text" || item.kind === "thinking") item.streaming = false
    })
  }

  function onStreamEvent(message: Of<"stream_event">): void {
    const key = message.parent_tool_use_id ?? MAIN
    const event = message.event
    switch (event.type) {
      case "message_start":
        cursors.set(key, { messageId: event.message.id, blocks: new Map(), lastIndex: -1, finalized: new Set() })
        return
      case "content_block_start": {
        const cursor = cursors.get(key)
        const item = startedItem(event.content_block)
        if (!cursor || !item) return
        cursor.blocks.set(event.index, item.id)
        cursor.lastIndex = event.index
        add(item, message.parent_tool_use_id)
        return
      }
      case "content_block_delta": {
        const id = cursors.get(key)?.blocks.get(event.index)
        const delta = event.delta
        if (!id) return
        if (delta.type === "text_delta") {
          update(id, (item) => {
            if (item.kind === "text") item.markdown += delta.text
          })
        } else if (delta.type === "thinking_delta") {
          update(id, (item) => {
            if (item.kind === "thinking") item.text += delta.thinking
          })
        } else if (delta.type === "input_json_delta") {
          update(id, (item) => {
            if (item.kind === "tool") item.inputText += delta.partial_json
          })
        }
        return
      }
      case "content_block_stop": {
        const id = cursors.get(key)?.blocks.get(event.index)
        if (id) stopStreaming(id)
        return
      }
      case "unknown":
        return
    }
  }

  function onAssistant(message: Of<"assistant">): void {
    const key = message.parent_tool_use_id ?? MAIN
    const usage = message.message.usage
    if (usage && !message.parent_tool_use_id) {
      setState(
        "usage",
        "context",
        "used",
        usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      )
    }
    for (const block of message.message.content) {
      if (block.type === "tool_use" && state.byId[block.id]) {
        finalize(block.id, block)
        continue
      }
      const cursor = cursors.get(key)
      const streamable = cursor && cursor.messageId === message.message.id && !cursor.finalized.has(cursor.lastIndex)
      const streamedId = streamable ? cursor.blocks.get(cursor.lastIndex) : undefined
      const streamed = streamedId ? state.byId[streamedId] : undefined
      const sameKind =
        streamed !== undefined &&
        ((streamed.kind === "text" && block.type === "text") ||
          (streamed.kind === "thinking" && block.type === "thinking"))
      if (cursor && streamedId && sameKind) {
        cursor.finalized.add(cursor.lastIndex)
        finalize(streamedId, block)
        continue
      }
      const item = startedItem(block)
      if (!item) continue
      add(item, message.parent_tool_use_id)
      finalize(item.id, block)
      stopStreaming(item.id)
    }
  }

  function onToolResults(message: Of<"user">): void {
    if (typeof message.message.content === "string") return
    const fileResult = message.tool_use_result
    for (const block of message.message.content) {
      if (block.type !== "tool_result") continue
      update(block.tool_use_id, (item) => {
        if (item.kind !== "tool") return
        item.status = block.is_error ? "error" : "done"
        item.result = toolResultText(block.content)
        if (fileResult?.structuredPatch) item.patch = fileResult.structuredPatch
        if (fileResult?.type === "create") item.createdFile = true
        // A background agent's tool result only says it launched; its outcome arrives as a task_notification.
        if (item.agent && !fileResult?.isAsync) {
          item.agent.state = block.is_error ? "failed" : "completed"
          item.agent.report = item.result
        }
      })
    }
  }

  function onResult(message: Of<"result">): void {
    for (const cursor of cursors.values()) for (const id of cursor.blocks.values()) stopStreaming(id)
    cursors.clear()
    const error = message.is_error ? (message.result ?? message.errors?.join("\n") ?? message.subtype) : null
    add(
      {
        kind: "turn-end",
        id: newId("turn"),
        costUsd: message.total_cost_usd,
        durationMs: message.duration_ms,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        error,
        interrupted: interruptSent,
        endedAt: now,
      },
      null,
    )
    const usage = message.usage
    const window = state.info ? message.modelUsage?.[state.info.model]?.contextWindow : undefined
    setState(
      "usage",
      produce((current) => {
        current.tokens +=
          usage.input_tokens +
          usage.output_tokens +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0)
        current.costUsd = message.total_cost_usd
        if (window !== undefined) current.context.window = window
      }),
    )
    setState("status", "idle")
  }

  function shifted(window: { utilization: number; resetsAt: number }): Window {
    return { utilization: window.utilization, resetsAt: window.resetsAt * 1000 + shift }
  }

  function onRateLimit(message: Of<"rate_limit_event">): void {
    const info = message.rate_limit_info
    const family = info.rateLimitType?.match(/^seven_day_(opus|sonnet)$/)?.[1]
    setState(
      "usage",
      produce((usage) => {
        const windows = info.unifiedWindows
        if (windows?.five_hour) usage.limits.fiveHour = shifted(windows.five_hour)
        if (windows?.seven_day) usage.limits.week = shifted(windows.seven_day)
        if (family && info.utilization !== undefined && info.resetsAt !== undefined) {
          usage.limits.models[family] = shifted({ utilization: info.utilization, resetsAt: info.resetsAt })
        }
        usage.warning =
          info.status === "allowed"
            ? null
            : {
                status: info.status,
                type: info.rateLimitType ?? "",
                resetsAt: info.resetsAt === undefined ? 0 : info.resetsAt * 1000 + shift,
              }
      }),
    )
  }

  function updateAgent(taskId: string, change: (agent: Agent) => void): void {
    const toolId = taskTools.get(taskId)
    if (!toolId) return
    update(toolId, (item) => {
      if (item.kind === "tool" && item.agent) change(item.agent)
    })
  }

  function onSystem(message: Of<"system">): void {
    switch (message.subtype) {
      case "init":
        setState("info", {
          id: message.session_id,
          model: message.model,
          permissionMode: message.permissionMode,
          cwd: message.cwd,
          cliVersion: message.claude_code_version,
          tools: message.tools,
          mcpServers: message.mcp_servers.map((server) => ({
            name: server.name,
            status: server.status,
            error: server.error ?? null,
          })),
          skills: message.skills,
          apiKeySource: message.apiKeySource ?? "none",
        })
        return
      case "compact_boundary":
        add({ kind: "system", id: newId("system"), text: "context compacted", level: "info" }, null)
        return
      case "api_retry":
        add(
          {
            kind: "system",
            id: newId("system"),
            text: `API retry ${message.attempt}/${message.max_retries}`,
            level: "warning",
          },
          null,
        )
        return
      case "background_tasks_changed":
        return
      case "task_started":
        if (message.tool_use_id) taskTools.set(message.task_id, message.tool_use_id)
        return
      case "task_progress":
        updateAgent(message.task_id, (agent) => {
          agent.toolUses = message.usage.tool_uses
          agent.durationMs = message.usage.duration_ms
        })
        return
      case "task_updated":
        updateAgent(message.task_id, (agent) => {
          if (message.patch.error) agent.error = message.patch.error
        })
        return
      case "task_notification":
        updateAgent(message.task_id, (agent) => {
          agent.state = message.status
          agent.report = message.summary
          if (message.usage) {
            agent.toolUses = message.usage.tool_uses
            agent.durationMs = message.usage.duration_ms
          }
        })
        return
    }
  }

  function onIncoming(message: ProtocolMessage): void {
    switch (message.type) {
      case "system":
        return onSystem(message)
      case "stream_event":
        return onStreamEvent(message)
      case "assistant":
        return onAssistant(message)
      case "user":
        return onToolResults(message)
      case "result":
        return onResult(message)
      case "control_request": {
        const request = message.request
        if (request.subtype !== "can_use_tool") return
        add(
          {
            kind: "ask",
            id: `ask-${message.request_id}`,
            requestId: message.request_id,
            toolUseId: request.tool_use_id,
            toolName: request.tool_name,
            displayName: request.display_name ?? request.tool_name,
            input: request.input,
            description: request.description ?? "",
            reason: Bun.stripANSI(request.decision_reason ?? ""),
            suggestion: request.suppress_always_allow_rule ? null : firstSuggestion(request.permission_suggestions),
            defaultToNo: request.default_to_no ?? false,
            safetyCheck: request.decision_reason_type === "safetyCheck",
            status: "pending",
            answers: {},
            notes: {},
          },
          null,
        )
        return
      }
      case "control_response":
        return
      case "rate_limit_event":
        return onRateLimit(message)
    }
  }

  function onOutgoing(message: ProtocolMessage): void {
    if (message.type === "user") {
      const { text, images } = describeUserContent(message.message.content)
      add({ kind: "user", id: newId("user"), text, images }, null)
      interruptSent = false
      setState("status", "running")
    } else if (message.type === "control_request" && message.request.subtype === "interrupt") {
      interruptSent = true
    } else if (message.type === "control_response") {
      const reply = message.response.response
      update(`ask-${message.response.request_id}`, (item) => {
        if (item.kind !== "ask") return
        const answers = reply?.updatedInput?.answers
        if (reply?.behavior === "deny") item.status = "denied"
        else if (answers) item.status = "answered"
        else item.status = "allowed"
        item.answers = answers ?? {}
        item.notes = notesOf(reply?.updatedInput?.annotations)
      })
    }
  }

  return {
    state,
    apply(dir, parsed, at) {
      now = at
      shift = Date.now() - at
      if (state.usage.startedAt === null) setState("usage", "startedAt", Date.now())
      if (parsed.kind === "invalid") {
        const seen = invalid.get(parsed.key)
        if (!seen) {
          const id = newId("system")
          invalid.set(parsed.key, { id, count: 1 })
          add({ kind: "system", id, text: `Could not read a ${parsed.key} message`, level: "warning" }, null)
          return
        }
        seen.count += 1
        update(seen.id, (item) => {
          if (item.kind === "system") item.text = `Could not read ${parsed.key} messages (×${seen.count})`
        })
        return
      }
      if (parsed.kind === "unknown") return
      if (dir === "in") onIncoming(parsed.message)
      else onOutgoing(parsed.message)
    },
    end() {
      for (const id of Object.keys(state.byId)) stopStreaming(id)
      cursors.clear()
      setState("status", "ended")
    },
  }
}
