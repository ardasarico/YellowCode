import type { ProtocolMessage } from "../../protocol/messages.ts"
import { readAgentMessage } from "../../session/agent-message.ts"
import { type Draft, imagesOf, textOf } from "./draft.ts"

const numbered = (index: number) => `Image ${index + 1}`

const SHELL_CONTEXT_BLOCK =
  /^<bash-input>[\s\S]*?<\/bash-input>\n<bash-stdout>[\s\S]*?<\/bash-stdout><bash-stderr>[\s\S]*?<\/bash-stderr>$/

// Walks back one block at a time; a regex over all of them backtracks exponentially.
export function stripShellContext(text: string): string {
  let rest = text
  for (;;) {
    const trimmed = rest.trimEnd()
    if (!trimmed.endsWith("</bash-stderr>")) return rest
    const start = trimmed.lastIndexOf("<bash-input>")
    if (start < 0 || !SHELL_CONTEXT_BLOCK.test(trimmed.slice(start))) return rest
    rest = trimmed.slice(0, start).trimEnd()
  }
}

// A user line as the chat shows it. `!` commands that went out after the message are shown on their own rows.
export function userOf(
  message: Extract<ProtocolMessage, { type: "user" }>,
): Omit<Extract<Draft, { type: "user" }>, "type"> {
  const content = message.message.content
  const raw = typeof content === "string" ? content : textOf(content)
  const images = typeof content === "string" ? [] : imagesOf(content, numbered)
  const text = stripShellContext(raw)
  const envelope = readAgentMessage(text)
  return {
    prompt: message.uuid ?? null,
    text: envelope ? envelope.text : text,
    images,
    to: envelope ? { task: envelope.id, name: envelope.name } : null,
    history: message.isReplay === true,
    cutPoint: message.uuid !== undefined,
  }
}
