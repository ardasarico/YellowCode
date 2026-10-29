import type { PartId, PromptId, ToolId } from "../../agent/ids.ts"
import type { ProtocolMessage } from "../../protocol/messages.ts"
import { readAgentMessage } from "../../session/agent-message.ts"
import { type Draft, textOf } from "./draft.ts"
import { stripShellContext } from "./user.ts"

type Pending = { to: string; prompt: PromptId | null; own: boolean; touched: boolean }

const RELAY_TOOLS = new Set(["ToolSearch", "SendMessage"])

// Replies told again after a rewind go out ahead of the message, each its own paragraph.
function agentMessageIn(text: string) {
  for (let at = 0; at >= 0; at = text.indexOf("\n\n<agent-message ", at + 1)) {
    const message = readAgentMessage(at === 0 ? text : text.slice(at + 2))
    if (message) return message
  }
  return null
}

// An @agent message is passed on by the main model with SendMessage; what it does for that stays out of the chat,
// unless the call fails. `own`: the message started its turn, so the model's whole turn is about passing it on.
// `touched`: the model has answered since, so the next result ends that turn.
export function createRelay() {
  let pending: Pending[] = []
  // Quiet calls of the message being passed on, which a refused message lets go.
  let quietTools: ToolId[] = []
  // Steps still left out of the chat, by part or call id, with the name of each call ("" for a text).
  const quiet = new Map<string, string>()
  let afterSend = false
  let running = false

  function shown(parts: PartId[], tools: ToolId[]): Draft[] {
    for (const id of [...parts, ...tools]) quiet.delete(id)
    return [{ type: "shown", parts, tools }]
  }

  function messageTo(input: unknown): string | undefined {
    const to = typeof input === "object" && input !== null && "to" in input ? input.to : undefined
    return typeof to === "string" && pending.some((entry) => entry.to === to) ? to : undefined
  }

  function started(): boolean {
    const after = afterSend
    afterSend = false
    for (const entry of pending) entry.touched = true
    return after
  }

  return {
    // A user line went out.
    sent(message: Extract<ProtocolMessage, { type: "user" }>): void {
      const content = message.message.content
      const raw = typeof content === "string" ? content : textOf(content)
      const to = agentMessageIn(stripShellContext(raw))?.id
      if (to) pending.push({ to, prompt: message.uuid ?? null, own: !running, touched: false })
      else {
        afterSend = false
        for (const entry of pending) entry.own = false
      }
      running = true
    },
    requesting(): void {
      running = true
    },
    // A main-thread text starts; true when it stays out of the chat.
    text(part: PartId): boolean {
      if (!started()) return false
      quiet.set(part, "")
      return true
    },
    // A main-thread call starts; true when it stays out of the chat.
    tool(id: ToolId, name: string): boolean {
      started()
      if (pending.length === 0 || !RELAY_TOOLS.has(name)) return false
      quietTools.push(id)
      quiet.set(id, name)
      return true
    },
    // A long text is an answer of its own, not the short line after passing a message on.
    textEnd(part: PartId, text: string): Draft[] {
      if (!quiet.has(part) || !(text.trim().includes("\n") || text.length > 160)) return []
      return shown([part], [])
    },
    // A quiet call whose input turns out to pass nothing on is shown.
    called(id: ToolId, input: unknown): Draft[] {
      const name = quiet.get(id)
      if (name === "ToolSearch" && !(JSON.stringify(input) ?? "").includes("SendMessage")) return shown([], [id])
      if (name === "SendMessage" && messageTo(input) === undefined) return shown([], [id])
      return []
    },
    // The result of a SendMessage call.
    settle(input: unknown, failed: boolean, text: string): Draft[] {
      const to = messageTo(input)
      if (to === undefined) return []
      const index = pending.findIndex((entry) => entry.to === to)
      const [entry] = index < 0 ? [] : pending.splice(index, 1)
      const ids = quietTools
      quietTools = []
      if (failed || /"success"\s*:\s*false/.test(text)) return ids.length > 0 ? shown([], ids) : []
      afterSend = entry?.own === true
      if (!entry?.prompt) return []
      return [
        {
          type: "delivered",
          prompt: entry.prompt,
          how: /resumedAgentId|Resuming agent/.test(text) ? "resumed" : "sent",
        },
      ]
    },
    // A turn ended. A message the model has not answered yet may wait for the next turn.
    finish(): void {
      pending = pending.filter((entry) => !entry.touched)
      quietTools = []
      quiet.clear()
      afterSend = false
      running = false
    },
    // claude is gone or starts over; the messages it had not passed on go with it.
    stop(): void {
      pending = []
      quietTools = []
      quiet.clear()
      running = false
    },
  }
}

export type Relay = ReturnType<typeof createRelay>
