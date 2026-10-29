import type { AskOutcome } from "../../agent/ask.ts"
import { INTERRUPTED_CALL } from "../../protocol/messages.ts"
import {
  DECLINED_WITH_NOTE,
  NOT_SHOWN,
  QUESTION_TO_CHAT,
  SUBAGENT_ASK,
  TOOL_DECLINED,
} from "../../protocol/outgoing.ts"
import { answersInResult, askKeys } from "./ask-input.ts"

// The words a no reached claude with, read back into why and the user's note.
export function denied(said: string): AskOutcome {
  if (said === QUESTION_TO_CHAT) return { status: "denied", said, why: "chat", note: "" }
  if (said === SUBAGENT_ASK) return { status: "denied", said, why: "subagent", note: "" }
  if (said.startsWith(NOT_SHOWN))
    return { status: "denied", said, why: "unshown", note: said.slice(NOT_SHOWN.length).replace(/\.$/, "") }
  const note = said.startsWith(DECLINED_WITH_NOTE)
    ? said.slice(DECLINED_WITH_NOTE.length)
    : said === TOOL_DECLINED
      ? ""
      : said
  return { status: "denied", said, why: "declined", note }
}

const isDenial = (said: string) =>
  said === QUESTION_TO_CHAT ||
  said === SUBAGENT_ASK ||
  said === TOOL_DECLINED ||
  said.startsWith(NOT_SHOWN) ||
  said.startsWith(DECLINED_WITH_NOTE)

// How a question call ended, read from its result alone, as for a call no live ask settled. An error in words of
// no denial is a failed call, not an answer.
export function resultOutcome(input: unknown, status: "done" | "error" | "stopped", result: string): AskOutcome | null {
  if (status === "stopped" || result.startsWith(INTERRUPTED_CALL)) return { status: "cancelled" }
  if (status === "error") return isDenial(result) ? denied(result) : null
  return { status: "answered", ...answersInResult(result, askKeys(input)) }
}
