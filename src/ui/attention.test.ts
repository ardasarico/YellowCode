import { expect, test } from "bun:test"
import type { AskOption } from "../agent/ask.ts"
import { endSession, feed } from "../agents/claude/translate.ts"
import { userMessage } from "../protocol/outgoing.ts"
import { parse } from "../protocol/parse.ts"
import { createSession } from "../session/session.ts"
import type { Ask, Item, Session, TurnEnd } from "../session/types.ts"
import { attentionState, notification } from "./attention.ts"

const option = { label: null, subject: null, note: false, endsTurn: false, mode: null }
const YES: AskOption = { ...option, id: "yes", effect: "allow", lasts: "once" }
const NO: AskOption = { ...option, id: "no", effect: "deny", lasts: "once", note: true }

const ask: Ask = {
  kind: "ask",
  id: "ask-1",
  requestId: "request-1",
  toolUseId: "tool-1",
  toolName: "Bash",
  toolKind: "shell",
  server: null,
  displayName: "Bash",
  input: {},
  target: "",
  writes: [],
  description: "",
  reason: "",
  options: [YES, NO],
  questions: null,
  plan: null,
  defaultToNo: false,
  safetyCheck: false,
  status: "pending",
  answers: {},
  notes: {},
  denial: "",
  why: null,
  note: "",
}

const turnEnd: TurnEnd = {
  kind: "turn-end",
  id: "end-1",
  costUsd: 0,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  error: null,
  retries: 0,
  interrupted: false,
  endedAt: 0,
}

const choice = (label: string) => ({ label, description: null, preview: null, image: null })
const page = { key: "Which?", header: "Pick", question: "Which?", multi: false, gallery: false, custom: true }
const questions = { pages: [{ ...page, options: [choice("A"), choice("B")] }] }

function sessionWith(items: Item[], status: Session["status"] = "idle"): Session {
  const base = createSession().state
  return { ...base, status, items: items.map((item) => item.id), byId: Object.fromEntries(items.map((i) => [i.id, i])) }
}

test("each state pings only at the levels that allow it", () => {
  const cases: [Session, string | null, string | null][] = [
    [sessionWith([ask], "running"), "Permission needed: Bash", "Permission needed: Bash"],
    [
      sessionWith([{ ...ask, toolName: "ask", toolKind: "question", options: [], questions }], "running"),
      "Claude has a question",
      "Claude has a question",
    ],
    [sessionWith([{ ...ask, status: "allowed" }], "running"), null, null],
    [sessionWith([turnEnd]), "Done", null],
    [sessionWith([{ ...turnEnd, error: "rate limited\nretry later" }]), "Error: rate limited", "Error: rate limited"],
    [sessionWith([]), null, null],
  ]
  for (const [session, all, waiting] of cases) {
    const attention = attentionState(session)
    expect(notification(attention, "all")).toBe(all)
    expect(notification(attention, "waiting")).toBe(waiting)
    expect(notification(attention, "off")).toBeNull()
  }
})

test("Claude Code going away mid-turn is an error, with its ask cancelled and its tool stopped", () => {
  const session = createSession()
  const input = { command: "sleep 9" }
  const incoming = (message: object) => feed(session, "in", parse(JSON.stringify(message)), 0)
  feed(session, "out", parse(userMessage("run it")), 0)
  incoming({ type: "assistant", message: { id: "a", content: [{ type: "tool_use", id: "t1", name: "Bash", input }] } })
  incoming({
    type: "control_request",
    request_id: "r1",
    request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "t1", input },
  })
  endSession(session, { text: "Claude Code stopped (SIGKILL)", detail: [] })

  expect(attentionState(session.state)).toMatchObject({ state: "error", error: "Claude Code stopped (SIGKILL)" })
  expect(session.state.byId["ask-r1"]).toMatchObject({ status: "cancelled" })
  expect(session.state.byId["t1"]).toMatchObject({ status: "stopped" })
  expect(session.state.status).toBe("ended")
})
