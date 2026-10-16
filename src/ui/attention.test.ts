import { expect, test } from "bun:test"
import { OWN_ASK } from "../protocol/messages.ts"
import { createSession } from "../session/session.ts"
import type { Ask, Item, Session, TurnEnd } from "../session/types.ts"
import { attentionState, notification } from "./attention.ts"

const ask: Ask = {
  kind: "ask",
  id: "ask-1",
  requestId: "request-1",
  toolUseId: "tool-1",
  toolName: "Bash",
  displayName: "Bash",
  input: {},
  description: "",
  reason: "",
  suggestion: null,
  defaultToNo: false,
  safetyCheck: false,
  status: "pending",
  answers: {},
  notes: {},
  denial: "",
}

const turnEnd: TurnEnd = {
  kind: "turn-end",
  id: "end-1",
  costUsd: 0,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  error: null,
  interrupted: false,
  endedAt: 0,
}

function sessionWith(items: Item[], status: Session["status"] = "idle"): Session {
  const base = createSession().state
  return { ...base, status, items: items.map((item) => item.id), byId: Object.fromEntries(items.map((i) => [i.id, i])) }
}

test("each state pings only at the levels that allow it", () => {
  const cases: [Session, string | null, string | null][] = [
    [sessionWith([ask], "running"), "Permission needed: Bash", "Permission needed: Bash"],
    [sessionWith([{ ...ask, toolName: OWN_ASK }], "running"), "Claude has a question", "Claude has a question"],
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
