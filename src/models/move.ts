import { type Ask, onceOption } from "../agent/ask.ts"
import type { Handoff } from "../session/handoff.ts"

const PREFIX = "move-"

const messages = (count: number) => `${count} ${count === 1 ? "message" : "messages"}`

// "6 messages and 2 images", and whether images stay behind with none going along.
function moving(handoff: Handoff): { what: string; stay: boolean } {
  const count = handoff.images.length
  const images = count === 0 ? "" : ` and ${count} ${count === 1 ? "image" : "images"}`
  return { what: `${messages(handoff.moved)}${images}`, stay: count === 0 && handoff.unmoved > 0 }
}

// The chat row in the new session.
export function movedNote(handoff: Handoff, from: string): string {
  const left = handoff.leftOut > 0 ? [`${handoff.leftOut} left out`] : []
  const { what, stay } = moving(handoff)
  const tools = `${stay ? "images did not move, " : ""}tools went as summaries`
  return [`Moved ${what} from ${from}`, ...left, tools].join(" · ")
}

// Asked before a message on a model of another provider moves the conversation. Esc cancels.
export function moveAsk(id: string, handoff: Handoff, from: string, to: string, model: string): Ask {
  const left = handoff.leftOut > 0 ? `, ${handoff.leftOut} left out` : ""
  const { what, stay } = moving(handoff)
  return {
    id: `${PREFIX}${id}`,
    kind: "permission",
    call: null,
    tool: { name: "switch", kind: "other", mcp: null },
    title: `Switch to ${model} · ${to}`,
    input: null,
    target:
      `A new ${to} session takes over. This conversation goes along as text ahead of your message: ` +
      `${what}${left}. ${stay ? "Images do not move; tools" : "Tools"} go as summaries. The ${from} session stays in /resume.`,
    preview: null,
    writes: [],
    detail: "",
    reason: "",
    options: [onceOption("switch", "allow", "Switch and send"), onceOption("cancel", "deny", "Cancel")],
    questions: null,
    plan: null,
    defaultNo: false,
    safety: false,
    by: null,
    own: null,
  }
}

export const moveOf = (askId: string): string | null => (askId.startsWith(PREFIX) ? askId.slice(PREFIX.length) : null)
