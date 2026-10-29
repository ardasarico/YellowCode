import type { AskReply } from "../../agent/ask.ts"
import { log } from "../../log/log.ts"
import { askUserQuestionInput, ownAskMatrix, ownAskPages, type PermissionUpdate } from "../../protocol/messages.ts"
import {
  allowAnswers,
  allowTool,
  answerQuestions,
  DECLINED_WITH_NOTE,
  denyTool,
  ownAskReply,
  QUESTION_TO_CHAT,
  TOOL_DECLINED,
} from "../../protocol/outgoing.ts"
import type { SessionStore } from "../../session/session.ts"
import type { Ask } from "../../session/types.ts"
import { answerSession } from "./translate.ts"

const allows = (ask: Ask, reply: AskReply) =>
  reply.type === "answers" ||
  (reply.type === "option" && ask.options.find((option) => option.id === reply.option)?.effect === "allow")

// The control_response line claude takes for the reply. An option is one the asks translator gave the ask; a lasting
// yes carries claude's suggestion as its grant.
export function answerLine(ask: Ask, reply: AskReply): string {
  const { requestId, input } = ask
  if (reply.type === "declined") return denyTool(requestId, reply.chat ? QUESTION_TO_CHAT : TOOL_DECLINED)
  if (reply.type === "option") {
    const option = ask.options.find((known) => known.id === reply.option)
    if (option?.effect !== "allow")
      return denyTool(requestId, reply.note ? DECLINED_WITH_NOTE + reply.note : TOOL_DECLINED)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a grant is set only by the asks translator
    const grant = option.grant as PermissionUpdate | undefined // SAFETY: the translator's grants are claude's updates
    return grant ? allowTool(requestId, input, [grant]) : allowTool(requestId, input)
  }
  // claude takes a multi-select's answer as one string.
  const { values: chosen, notes, note } = reply.answers
  const values = Object.fromEntries(Object.entries(chosen).map(([key, parts]) => [key, parts.join(", ")]))
  const pages = (ask.toolName === "AskUserQuestion" ? askUserQuestionInput : ownAskPages).safeParse(input).data
  if (pages) return answerQuestions(requestId, pages, values, notes, note)
  const matrix = ownAskMatrix.safeParse(input).data?.matrix
  return allowAnswers(requestId, matrix ? { matrix } : {}, values, notes)
}

// Settles the ask with the reply and sends it. A yes to a main-agent call waits for `before`, which reads what the
// call may change first.
export async function answerAsk(
  store: SessionStore,
  ask: Ask,
  reply: AskReply,
  send: (line: string) => void,
  before?: (ask: Ask) => Promise<void> | undefined,
): Promise<void> {
  // The reply carries the tool's whole input (a Write's file) and the user's notes, so only its gist is logged.
  log.info(`answer to ${ask.toolName}`, { requestId: ask.requestId, behavior: allows(ask, reply) ? "allow" : "deny" })
  const response = answerLine(ask, reply)
  if (ask.mcp) {
    // claude may have given the call up (an interrupt) while the user answered.
    const now = store.state.byId[ask.id]
    if (now?.kind !== "ask" || now.status !== "pending") return log.info("dropped a late own ask answer")
    const result = ownAskReply(ask, ask.mcp.rpcId, response)
    answerSession(store, result)
    send(result)
    return
  }
  answerSession(store, response)
  const reading = allows(ask, reply) && !ask.agent ? before?.(ask) : undefined
  if (reading) await reading.finally(() => send(response))
  else send(response)
}
