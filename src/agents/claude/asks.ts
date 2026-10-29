import type { z } from "zod"
import type { Ask, AskOption, AskOutcome, Lasts, Questions } from "../../agent/ask.ts"
import type { AskId, ToolId } from "../../agent/ids.ts"
import { log } from "../../log/log.ts"
import {
  mcpCancelled,
  OWN_ASK,
  OWN_ASK_SERVER,
  ownAskCall,
  ownAskMatrix,
  ownAskPages,
  ownAskResult,
  type PermissionUpdate,
  permissionReply,
  type ProtocolMessage,
  questionAnswers,
} from "../../protocol/messages.ts"
import { answersInResult, askKeys } from "../../session/ask.ts"
import { summarizeToolInput } from "../../session/tool-summary.ts"
import type { Draft } from "./draft.ts"
import { denied } from "./outcome.ts"
import { field, kindOf, mcpOf, text, type Tools } from "./tools.ts"

type Of<T extends ProtocolMessage["type"]> = Extract<ProtocolMessage, { type: T }>
type CanUseTool = Extract<Of<"control_request">["request"], { subtype: "can_use_tool" }>

function option(id: string, effect: AskOption["effect"], lasts: Lasts, more: Partial<AskOption> = {}): AskOption {
  return { id, effect, lasts, label: null, subject: null, note: false, endsTurn: false, mode: null, ...more }
}

const YES = option("yes", "allow", "once")
const NO = option("no", "deny", "once", { note: true })

// Where claude keeps the update decides how long it lasts.
function lastsOf(update: PermissionUpdate): Lasts {
  if (update.destination === "session" || update.destination === "cliArg") return "session"
  if (update.destination === "userSettings") return "everywhere"
  if (update.destination) return "project"
  return update.type === "setMode" ? "session" : "project"
}

function subjectOf(update: PermissionUpdate): string | null {
  if (update.type === "setMode") return update.mode ?? null
  if (update.type === "addDirectories") return update.directories?.join(", ") ?? null
  const rule = update.rules?.[0]
  return rule?.ruleContent ?? rule?.toolName ?? null
}

// A yes, one lasting yes per suggestion (switching to auto mode is never offered), and a no that takes a note.
function permissionOptions(request: CanUseTool): AskOption[] {
  const suggestions = request.suppress_always_allow_rule ? [] : (request.permission_suggestions ?? [])
  const always = suggestions
    .filter((update) => !(update.type === "setMode" && update.mode === "auto"))
    .map((update, index) =>
      option(`always-${index}`, "allow", lastsOf(update), {
        subject: subjectOf(update),
        grant: update,
      }),
    )
  return [YES, ...always, NO]
}

// AskUserQuestion's pages, or our own ask's pages or matrix; a page is filed under its question.
function questionsOf(input: unknown): Questions | null {
  const matrix = ownAskMatrix.safeParse(input).data?.matrix
  if (matrix)
    return {
      matrix: {
        header: matrix.header,
        question: matrix.question,
        rows: matrix.rows.map((row) => row.label),
        scale: matrix.scale,
      },
    }
  const pages = ownAskPages.safeParse(input).data?.questions
  if (!pages) return null
  return {
    pages: pages.map((page) => ({
      key: page.question,
      header: page.header,
      question: page.question,
      multi: page.multiSelect ?? false,
      gallery: page.gallery ?? false,
      custom: true,
      options: page.options.map((choice) => ({
        label: choice.label,
        description: choice.description ?? null,
        preview: text(field(choice, "preview")),
        image: choice.image ?? null,
      })),
    })),
  }
}

function permissionAsk(id: AskId, request: CanUseTool): Ask {
  const name = request.tool_name
  const kind = kindOf(name)
  const input = request.input
  const path = text(field(input, "file_path")) ?? text(field(input, "notebook_path"))
  return {
    id,
    kind: kind === "question" ? "question" : kind === "plan" ? "plan" : "permission",
    call: request.tool_use_id,
    tool: { name, kind, mcp: mcpOf(name) },
    title: request.display_name ?? name,
    input,
    target: (kind === "shell" ? text(field(input, "command")) : null) ?? summarizeToolInput(input),
    preview: null,
    writes: path && (kind === "edit" || kind === "write") ? [path] : [],
    detail: request.description ?? "",
    reason: Bun.stripANSI(request.decision_reason ?? ""),
    options: kind === "question" ? [] : kind === "plan" ? [YES, NO] : permissionOptions(request),
    questions: kind === "question" ? questionsOf(input) : null,
    plan: kind === "plan" ? { text: text(field(input, "plan")) ?? "", path: text(field(input, "planFilePath")) } : null,
    defaultNo: request.default_to_no ?? false,
    safety: request.decision_reason_type === "safetyCheck",
    by: request.agent_id ?? null,
    own: null,
  }
}

function ownAsk(id: AskId, handle: string | number, call: ToolId, input: unknown): Ask {
  return {
    id,
    kind: "question",
    call: call || null,
    tool: { name: OWN_ASK, kind: "question", mcp: mcpOf(OWN_ASK) },
    title: "ask",
    input,
    target: summarizeToolInput(input),
    preview: null,
    writes: [],
    detail: "",
    reason: "",
    options: [],
    questions: questionsOf(input),
    plan: null,
    defaultNo: false,
    safety: false,
    by: null,
    own: { handle },
  }
}

function notesOf(annotations: Record<string, { notes?: string }> | undefined): Record<string, string> {
  const notes: Record<string, string> = {}
  for (const [question, annotation] of Object.entries(annotations ?? {})) {
    if (annotation.notes) notes[question] = annotation.notes
  }
  return notes
}

const close = (id: AskId, outcome: AskOutcome): Draft => ({ type: "ask.close", id, outcome })

function unreadable(error: z.ZodError): Draft[] {
  log.warn(`invalid control_response message: ${error.message}`)
  return [{ type: "unreadable", what: "control_response" }]
}

// Our own ask settles from its MCP result: an error is a no, else the answers are read back from the text.
function ownReply(ask: Ask, payload: unknown): Draft[] {
  const result = ownAskResult.safeParse(payload).data?.mcp_response.result
  if (!result) return []
  const said = result.content.map((block) => block.text ?? "").join("")
  if (result.isError) return [close(ask.id, denied(said))]
  return [close(ask.id, { status: "answered", ...answersInResult(said, askKeys(ask.input)) })]
}

// Permission asks, AskUserQuestion and our own ask tool. An ask settles from the reply that goes out for it.
export function createAsks(tools: Tools) {
  // Every ask opened, by request id.
  const opened = new Map<AskId, Ask>()
  // Calls to our own ask not yet known to be the main agent's, by tool_use id.
  const held = new Map<ToolId, Ask>()

  function open(ask: Ask): Draft[] {
    opened.set(ask.id, ask)
    return [{ type: "ask.open", ask }]
  }

  function cancelOwn(handle: string | number): Draft[] {
    for (const [call, ask] of held) if (ask.own?.handle === handle) held.delete(call)
    return [...opened.values()].flatMap((ask) =>
      ask.own?.handle === handle ? [close(ask.id, { status: "cancelled" })] : [],
    )
  }

  return {
    request(message: Of<"control_request">): Draft[] {
      const request = message.request
      // Our own ask opens from its tools/call; a permission ask for it is allowed at once.
      if (request.subtype === "can_use_tool")
        return request.tool_name === OWN_ASK ? [] : open(permissionAsk(message.request_id, request))
      if (request.subtype !== "mcp_message" || request.server_name !== OWN_ASK_SERVER) return []
      const { id: rpcId, method, params } = request.message
      if (method === "notifications/cancelled") {
        const cancelled = mcpCancelled.safeParse(params).data
        return cancelled ? cancelOwn(cancelled.requestId) : []
      }
      const call = ownAskCall.safeParse(params).data
      if (method !== "tools/call" || rpcId === undefined || call?.name !== "ask") return []
      const ask = ownAsk(message.request_id, rpcId, call.toolUseId, call.input)
      // Only the main agent's call opens. Its tool_use line came first; any other call waits for the ask server to
      // place it (`openHeld`) or turn it down.
      if (tools.parentOf(call.toolUseId) === null) return open(ask)
      held.set(call.toolUseId, ask)
      return []
    },
    cancel(message: Of<"control_cancel_request">): Draft[] {
      return opened.has(message.request_id) ? [close(message.request_id, { status: "cancelled" })] : []
    },
    openHeld(call: ToolId): Ask | null {
      const ask = held.get(call)
      if (!ask) return null
      held.delete(call)
      opened.set(ask.id, ask)
      return ask
    },
    // An outgoing control_response: the user's answer, or the ask server's reply.
    reply(message: Of<"control_response">): Draft[] {
      const id = message.response.request_id
      const payload = message.response.response
      for (const [call, ask] of held) {
        if (ask.id !== id) continue
        held.delete(call)
        return []
      }
      const ask = opened.get(id)
      if (ask?.own) return ownReply(ask, payload)
      const parsed = payload === undefined ? null : permissionReply.safeParse(payload)
      // A reply that cannot be read must not settle the ask, least of all as allowed.
      if (parsed && !parsed.success) return unreadable(parsed.error)
      const reply = parsed?.data
      const answered =
        ask?.kind === "question" && reply?.updatedInput !== undefined
          ? questionAnswers.safeParse(reply.updatedInput)
          : null
      if (answered && !answered.success) return unreadable(answered.error)
      if (!ask) return []
      if (reply?.behavior === "deny") return [close(id, denied(reply.message ?? ""))]
      const answers = answered?.data.answers
      if (answers) return [close(id, { status: "answered", answers, notes: notesOf(answered.data.annotations) })]
      return [close(id, { status: "allowed" })]
    },
    // claude is gone or starts over, and with it the calls held asks would answer.
    stop(): void {
      held.clear()
    },
  }
}
