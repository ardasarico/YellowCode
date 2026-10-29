import { z } from "zod"
import { parseJson } from "../json.ts"
import { KNOWN_KEYS, protocolMessage, type ProtocolMessage } from "./messages.ts"

export type ParseResult =
  | { kind: "message"; message: ProtocolMessage }
  | { kind: "unknown"; key: string }
  | { kind: "invalid"; key: string; raw: string; error: string }

const envelope = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  request: z.looseObject({ subtype: z.string() }).optional(),
})

function keyOf(head: z.infer<typeof envelope>): string {
  if (head.type === "system") return `system/${head.subtype ?? ""}`
  if (head.type === "control_request") return `control_request/${head.request?.subtype ?? ""}`
  return head.type
}

export function parse(line: string): ParseResult {
  const json = parseJson(line)
  if (!json.ok) return { kind: "invalid", key: "json", raw: line, error: json.error }

  const head = envelope.safeParse(json.value)
  if (!head.success) return { kind: "invalid", key: "envelope", raw: line, error: z.prettifyError(head.error) }

  const key = keyOf(head.data)
  if (!KNOWN_KEYS.has(key)) return { kind: "unknown", key }

  const message = protocolMessage.safeParse(json.value)
  if (!message.success) return { kind: "invalid", key, raw: line, error: z.prettifyError(message.error) }
  return { kind: "message", message: message.data }
}
