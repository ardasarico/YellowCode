import type { PermissionUpdate } from "./messages.ts"

export type OutgoingImage = {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  base64: string
}

export function userMessage(text: string, images: OutgoingImage[] = []): string {
  const content =
    images.length === 0
      ? text
      : [
          ...images.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.base64 },
          })),
          { type: "text", text },
        ]
  return JSON.stringify({ type: "user", parent_tool_use_id: null, message: { role: "user", content } })
}

export const TOOL_DECLINED = "The user declined this tool call."
export const QUESTION_DECLINED = "The user declined to answer."

function permissionResponse(requestId: string, response: unknown): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  })
}

export function allowTool(requestId: string, input: unknown, updatedPermissions?: PermissionUpdate[]): string {
  return permissionResponse(requestId, { behavior: "allow", updatedInput: input, updatedPermissions })
}

export function denyTool(requestId: string, message: string): string {
  return permissionResponse(requestId, { behavior: "deny", message })
}

// The model sees notes only under a question's own key, so an additional note joins the last question's notes.
export function answerQuestions(
  requestId: string,
  input: { questions: { question: string }[] },
  answers: Record<string, string>,
  notes: Record<string, string>,
  additionalNote = "",
): string {
  const last = input.questions.at(-1)?.question
  const withExtra = { ...notes }
  if (additionalNote !== "" && last !== undefined) {
    const extra = `Additional note: ${additionalNote}`
    withExtra[last] = withExtra[last] ? `${withExtra[last]}\n${extra}` : extra
  }
  const annotations = Object.fromEntries(
    Object.entries(withExtra)
      .filter(([, note]) => note !== "")
      .map(([question, note]) => [question, { notes: note }]),
  )
  const updatedInput = {
    ...input,
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  }
  return permissionResponse(requestId, { behavior: "allow", updatedInput })
}

export function interruptRequest(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })
}
