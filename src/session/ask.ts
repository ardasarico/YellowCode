import { OWN_ASK, ownAskMatrix, ownAskPages, type ProtocolMessage } from "../protocol/messages.ts"
import { denyTool } from "../protocol/outgoing.ts"
import type { Ask } from "./types.ts"

const MOST_CHOICES = 4

export function severe(ask: Ask): boolean {
  return ask.defaultToNo || ask.safetyCheck
}

const repeats = (texts: string[]) => new Set(texts).size < texts.length

// What our own ask breaks, in words for Claude. Null when it can be shown, and for input of another shape, which
// the permission band shows.
export function ownAskProblem(ask: Pick<Ask, "toolName" | "input">): string | null {
  if (ask.toolName !== OWN_ASK) return null
  const questions = ownAskPages.safeParse(ask.input).data?.questions
  if (questions) {
    if (questions.length === 0) return "at least 1 question"
    if (questions.some((page) => page.options.length > MOST_CHOICES)) return "at most 4 options per question"
    if (questions.some((page) => page.options.length < 2)) return "at least 2 options per question"
    if (questions.some((page) => page.gallery && !page.options.every((option) => option.image)))
      return "every option in a gallery needs an image"
    if (repeats(questions.map((page) => page.question))) return "questions must be unique"
    return null
  }
  const matrix = ownAskMatrix.safeParse(ask.input).data?.matrix
  if (!matrix) return null
  if (matrix.scale.length > MOST_CHOICES) return "at most 4 steps in the scale"
  if (matrix.scale.length < 2) return "at least 2 steps in the scale"
  if (matrix.rows.length < 2) return "at least 2 rows"
  if (repeats(matrix.rows.map((row) => row.label))) return "row labels must be unique"
  return null
}

// The deny that sends a broken own ask back to Claude unseen, or null for any other message.
export function ownAskRejection(message: ProtocolMessage): string | null {
  if (message.type !== "control_request" || message.request.subtype !== "can_use_tool") return null
  const problem = ownAskProblem({ toolName: message.request.tool_name, input: message.request.input })
  return problem ? denyTool(message.request_id, `Not shown to the user. Fix this and ask again: ${problem}.`) : null
}
