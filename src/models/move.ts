import type { Ask, AskOption } from "../agent/ask.ts"
import type { Handoff } from "../session/handoff.ts"

const PREFIX = "move-"

const option = (id: string, effect: AskOption["effect"], label: string): AskOption => ({
  id,
  effect,
  lasts: "once",
  label,
  subject: null,
  note: false,
  endsTurn: false,
  mode: null,
})

const messages = (count: number) => `${count} ${count === 1 ? "message" : "messages"}`

// The chat row in the new session.
export function movedNote(handoff: Handoff, from: string): string {
  const left = handoff.leftOut > 0 ? [`${handoff.leftOut} left out`] : []
  return [
    `Moved ${messages(handoff.moved)} from ${from}`,
    ...left,
    "images did not move, tools went as summaries",
  ].join(" · ")
}

// Asked before a message on a model of another provider moves the conversation. Esc cancels.
export function moveAsk(id: string, handoff: Handoff, from: string, to: string, model: string): Ask {
  const left = handoff.leftOut > 0 ? `, ${handoff.leftOut} left out` : ""
  return {
    id: `${PREFIX}${id}`,
    kind: "permission",
    call: null,
    tool: { name: "switch", kind: "other", mcp: null },
    title: `Switch to ${model} · ${to}`,
    input: null,
    target:
      `A new ${to} session takes over. This conversation goes along as text ahead of your message: ` +
      `${messages(handoff.moved)}${left}. Images and tool results do not move. The ${from} session stays in /resume.`,
    preview: null,
    writes: [],
    detail: "",
    reason: "",
    options: [option("switch", "allow", "Switch and send"), option("cancel", "deny", "Cancel")],
    questions: null,
    plan: null,
    defaultNo: false,
    safety: false,
    by: null,
    own: null,
  }
}

export const moveOf = (askId: string): string | null => (askId.startsWith(PREFIX) ? askId.slice(PREFIX.length) : null)
