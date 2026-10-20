import type { PermissionUpdate } from "./messages.ts"

export type OutgoingImage = {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  base64: string
}

// A uuid makes claude report when a message sent during a turn is taken in (command_lifecycle).
export function userMessage(text: string, images: OutgoingImage[] = [], uuid?: string): string {
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
  return JSON.stringify({ type: "user", parent_tool_use_id: null, uuid, message: { role: "user", content } })
}

export const TOOL_DECLINED = "The user declined this tool call."
// A note on its own reads like the tool's output, so it goes out as what the user said.
export const DECLINED_WITH_NOTE = "The user declined this tool call and said:\n"
export const QUESTION_TO_CHAT =
  "The user wants to talk this over in the chat instead of answering. Stop and wait for their message."

export function errorResponse(requestId: string, message: string): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "error", request_id: requestId, error: message },
  })
}

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
  return allowAnswers(requestId, input, answers, withExtra)
}

// A matrix answers each row by its label.
export function allowAnswers(
  requestId: string,
  input: object,
  answers: Record<string, string>,
  notes: Record<string, string>,
): string {
  const annotations = Object.fromEntries(
    Object.entries(notes)
      .filter(([, note]) => note !== "")
      .map(([key, note]) => [key, { notes: note }]),
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

export function initializeRequest(requestId: string, options: { perTaskStopAffordance?: boolean } = {}): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "initialize", ...options },
  })
}

export function getTaskOutputRequest(requestId: string, taskId: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "get_task_output", task_id: taskId },
  })
}

export function stopTaskRequest(requestId: string, taskId: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "stop_task", task_id: taskId },
  })
}

export function renameSession(requestId: string, title: string, sessionId?: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "rename_session", title, session_id: sessionId },
  })
}

export function getSettingsRequest(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "get_settings" } })
}

export function getHooksListingRequest(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "get_hooks_listing" } })
}

export function getSkillsDialogRequest(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "get_skills_dialog" } })
}
