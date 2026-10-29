import { permissionReply, type PermissionUpdate, questionAnswers } from "./messages.ts"
import { ownAskAnswerText, withAdditionalNote } from "./own-ask-text.ts"
import { parse } from "./parse.ts"

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

// The line that goes out and the one the chat shows at once. `told` goes before the text and `after` after it; the
// chat shows neither.
export function promptLines(
  text: string,
  images: OutgoingImage[],
  uuid: string,
  told: string[] = [],
  after: string[] = [],
): { sent: string; shown: string } {
  const sent = userMessage([...told, text, ...after].filter((part) => part !== "").join("\n\n"), images, uuid)
  return { sent, shown: told.length + after.length > 0 ? userMessage(text, images, uuid) : sent }
}

// What claude said while the conversation was rewound; the next message tells it again.
export const keptReply = (reply: string) =>
  `While the conversation was rewound, a background task finished and you said:\n${reply}`

// A `!` command and its output, in the form Claude Code gives its own shell mode; it goes out ahead of the next message.
export function shellContext(command: string, output: string): string {
  return `<bash-input>${command}</bash-input>\n<bash-stdout>${output}</bash-stdout><bash-stderr></bash-stderr>`
}

export const TOOL_DECLINED = "The user declined this tool call."
// A note on its own reads like the tool's output, so it goes out as what the user said.
export const DECLINED_WITH_NOTE = "The user declined this tool call and said:\n"
export const QUESTION_TO_CHAT =
  "The user wants to talk this over in the chat instead of answering. Stop and wait for their message."
// Our own ask turns these calls down unseen; the problem or the reason follows.
export const NOT_SHOWN = "Not shown to the user. Fix this and ask again: "
export const SUBAGENT_ASK =
  "Only the main agent can ask the user. Do not ask again: finish your task and put this question in your final " +
  "report, so the main agent can ask it."

export function errorResponse(requestId: string, message: string): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "error", request_id: requestId, error: message },
  })
}

function successResponse(requestId: string, response: unknown): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  })
}

export function allowTool(requestId: string, input: unknown, updatedPermissions?: PermissionUpdate[]): string {
  return successResponse(requestId, { behavior: "allow", updatedInput: input, updatedPermissions })
}

export function denyTool(requestId: string, message: string): string {
  return successResponse(requestId, { behavior: "deny", message })
}

export function answerQuestions(
  requestId: string,
  input: { questions: { question: string }[] },
  answers: Record<string, string>,
  notes: Record<string, string>,
  additionalNote = "",
): string {
  const withExtra = withAdditionalNote(notes, input.questions.at(-1)?.question, additionalNote)
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
  return successResponse(requestId, { behavior: "allow", updatedInput })
}

type RpcId = string | number

export function mcpResponse(requestId: string, rpcId: RpcId, result: unknown): string {
  return successResponse(requestId, { mcp_response: { jsonrpc: "2.0", id: rpcId, result } })
}

export function mcpError(requestId: string, rpcId: RpcId, code: number, message: string): string {
  return successResponse(requestId, { mcp_response: { jsonrpc: "2.0", id: rpcId, error: { code, message } } })
}

// A JSON-RPC notification has no id to answer, but claude still waits for its control_response.
export function mcpAck(requestId: string): string {
  return successResponse(requestId, { mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } })
}

// A tool error claude passes on to the model as the call's result.
export function mcpToolError(requestId: string, rpcId: RpcId, text: string): string {
  return mcpResponse(requestId, rpcId, { content: [{ type: "text", text }], isError: true })
}

// Our own ask's answer goes back as its MCP result.
export function ownAskReply(ask: { requestId: string; input: unknown }, rpcId: RpcId, response: string): string {
  const line = parse(response)
  const sent = line.kind === "message" && line.message.type === "control_response" ? line.message.response : null
  const reply = permissionReply.safeParse(sent?.response).data
  if (reply?.behavior !== "allow") return mcpToolError(ask.requestId, rpcId, reply?.message ?? TOOL_DECLINED)
  const answered = questionAnswers.safeParse(reply.updatedInput).data
  const notes = Object.fromEntries(Object.entries(answered?.annotations ?? {}).map(([key, note]) => [key, note.notes]))
  const text = ownAskAnswerText(ask.input, answered?.answers ?? {}, notes)
  return mcpResponse(ask.requestId, rpcId, { content: [{ type: "text", text }] })
}

function controlRequest(requestId: string, subtype: string, fields: object = {}): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype, ...fields } })
}

export const getContextUsageRequest = (requestId: string) => controlRequest(requestId, "get_context_usage")
export const getUsageRequest = (requestId: string) => controlRequest(requestId, "get_usage")
export const reloadSkillsRequest = (requestId: string) => controlRequest(requestId, "reload_skills")

export const mcpSetServersRequest = (requestId: string, servers: Record<string, unknown>) =>
  controlRequest(requestId, "mcp_set_servers", { servers })

export function interruptRequest(requestId: string): string {
  return controlRequest(requestId, "interrupt")
}

export function initializeRequest(
  requestId: string,
  options: {
    perTaskStopAffordance?: boolean
    sdkMcpServers?: string[]
    sdkMcpServerConfigs?: Record<string, { timeout: number }>
  } = {},
): string {
  return controlRequest(requestId, "initialize", options)
}

export function getTaskOutputRequest(requestId: string, taskId: string): string {
  return controlRequest(requestId, "get_task_output", { task_id: taskId })
}

export function stopTaskRequest(requestId: string, taskId: string): string {
  return controlRequest(requestId, "stop_task", { task_id: taskId })
}

// Every foreground Bash command and agent goes to the background, as Ctrl+B does in Claude Code.
export function backgroundTasksRequest(requestId: string): string {
  return controlRequest(requestId, "background_tasks")
}

// Steps the conversation back to before this prompt; claude takes only its latest remaining prompt.
export function rewindConversationRequest(requestId: string, uuid: string): string {
  return controlRequest(requestId, "rewind_conversation", { target_message_uuid: uuid })
}

export function renameSession(requestId: string, title: string, sessionId?: string): string {
  return controlRequest(requestId, "rename_session", { title, session_id: sessionId })
}

export function getSettingsRequest(requestId: string): string {
  return controlRequest(requestId, "get_settings")
}

export function setPermissionModeRequest(requestId: string, mode: string): string {
  return controlRequest(requestId, "set_permission_mode", { mode })
}

export function setModelRequest(requestId: string, model: string): string {
  return controlRequest(requestId, "set_model", { model })
}

// Settings claude takes as if they were launch flags: effortLevel, ultracode.
export function applyFlagSettingsRequest(requestId: string, settings: Record<string, unknown>): string {
  return controlRequest(requestId, "apply_flag_settings", { settings })
}

export function thinkingDisplayRequest(requestId: string, display: "summarized" | "omitted"): string {
  return controlRequest(requestId, "set_max_thinking_tokens", { thinking_display: display })
}

export function fileSuggestionsRequest(requestId: string, query: string): string {
  return controlRequest(requestId, "file_suggestions", { query })
}

export function getHooksListingRequest(requestId: string): string {
  return controlRequest(requestId, "get_hooks_listing")
}

export function getSkillsDialogRequest(requestId: string): string {
  return controlRequest(requestId, "get_skills_dialog")
}

export function mcpStatusRequest(requestId: string): string {
  return controlRequest(requestId, "mcp_status")
}

export function mcpReconnectRequest(requestId: string, serverName: string): string {
  return controlRequest(requestId, "mcp_reconnect", { serverName })
}

export function mcpToggleRequest(requestId: string, serverName: string, enabled: boolean): string {
  return controlRequest(requestId, "mcp_toggle", { serverName, enabled })
}

// The user asked for the change, so the reload is applied even when it costs the prompt cache.
export function reloadPluginsRequest(requestId: string): string {
  return controlRequest(requestId, "reload_plugins")
}
