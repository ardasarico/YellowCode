// Pi extensions' dialogs as YellowCode asks: a confirm is a yes or no, a select a question page with its options, an
// input or editor a page answered by typing. Pi resolves a dialog itself once its timeout passes, so the ask closes
// then too.
import type { Ask, AskOption, AskOutcome, AskReply, QuestionPage } from "../../agent/ask.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { AskId } from "../../agent/ids.ts"

const KEY = "answer"
const KEEP = "Keep it as it is"

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

const blank = {
  call: null,
  input: null,
  preview: null,
  writes: [],
  reason: "",
  plan: null,
  defaultNo: false,
  safety: false,
  by: null,
  own: null,
} satisfies Partial<Ask>

const text = (value: unknown) => (typeof value === "string" ? value : "")

const page = (question: string, options: { label: string; preview: string | null }[]): QuestionPage => ({
  key: KEY,
  header: "Pi",
  question,
  multi: false,
  gallery: false,
  custom: true,
  options: options.map(({ label, preview }) => ({ label, description: null, preview, image: null })),
})

function askOf(id: AskId, raw: Record<string, unknown>): Ask | null {
  const title = text(raw["title"]) || "A pi extension asks"
  const tool = { name: "extension", kind: "question" as const, mcp: null }
  switch (raw["method"]) {
    case "confirm":
      return {
        ...blank,
        id,
        kind: "permission",
        tool,
        title: "Pi extension",
        target: title,
        detail: text(raw["message"]),
        options: [option("yes", "allow", "Yes"), option("no", "deny", "No")],
        questions: null,
      }
    case "select": {
      const options = Array.isArray(raw["options"]) ? raw["options"].map(text).filter((one) => one !== "") : []
      return {
        ...blank,
        id,
        kind: "question",
        tool,
        title: "Pi extension",
        target: title,
        detail: "",
        options: [],
        questions: {
          pages: [
            {
              ...page(
                title,
                options.map((label) => ({ label, preview: null })),
              ),
              custom: false,
            },
          ],
        },
      }
    }
    case "input":
    case "editor": {
      const prefill = text(raw["prefill"])
      return {
        ...blank,
        id,
        kind: "question",
        tool,
        title: "Pi extension",
        target: title,
        detail: text(raw["placeholder"]),
        options: [],
        questions: { pages: [page(title, prefill ? [{ label: KEEP, preview: prefill }] : [])] },
      }
    }
    default:
      return null
  }
}

type Open = { method: string; options: string[]; prefill: string | null; timer: Timer | null }

export type Asks = {
  // An extension_ui_request for a dialog; the events that open its ask.
  open(raw: Record<string, unknown>, at: number): AgentEvent[]
  answer(id: AskId, reply: AskReply, at: number): AgentEvent[]
  // Pi went away: every open ask closes.
  gone(at: number): AgentEvent[]
}

export function createAsks(deps: {
  // The response to a dialog, sent to pi.
  respond(id: string, fields: Record<string, unknown>): void
  tell(events: AgentEvent[]): void
}): Asks {
  const open = new Map<AskId, Open>()

  const close = (id: AskId, outcome: AskOutcome, at: number): AgentEvent[] => {
    const known = open.get(id)
    if (!known) return []
    if (known.timer) clearTimeout(known.timer)
    open.delete(id)
    return [{ type: "ask.close", id, outcome, at }]
  }

  return {
    open(raw, at) {
      const id = text(raw["id"])
      const ask = id === "" ? null : askOf(id, raw)
      if (!ask) return []
      const timeout = typeof raw["timeout"] === "number" && raw["timeout"] > 0 ? raw["timeout"] : null
      const options = ask.questions && "pages" in ask.questions ? (ask.questions.pages[0]?.options ?? []) : []
      open.set(id, {
        method: text(raw["method"]),
        options: options.map((one) => one.label),
        prefill: text(raw["prefill"]) || null,
        timer:
          timeout === null
            ? null
            : setTimeout(() => deps.tell(close(id, { status: "cancelled" }, Date.now())), timeout),
      })
      return [{ type: "ask.open", ask, at }]
    },
    answer(id, reply, at) {
      const known = open.get(id)
      if (!known) return []
      if (reply.type === "declined") {
        deps.respond(id, { cancelled: true })
        return close(id, { status: "denied", said: "", why: reply.chat ? "chat" : "declined", note: "" }, at)
      }
      if (known.method === "confirm") {
        const yes = reply.type === "option" && reply.option === "yes"
        deps.respond(id, { confirmed: yes })
        return close(id, yes ? { status: "allowed" } : { status: "denied", said: "", why: "declined", note: "" }, at)
      }
      const given = reply.type === "answers" ? (reply.answers.values[KEY]?.[0] ?? "") : ""
      const value = given === KEEP && known.prefill !== null ? known.prefill : given
      // A select takes only one of its options.
      if (known.method === "select" && !known.options.includes(value)) {
        deps.respond(id, { cancelled: true })
        return close(id, { status: "cancelled" }, at)
      }
      deps.respond(id, { value })
      return close(id, { status: "answered", answers: { [KEY]: value }, notes: {} }, at)
    },
    gone(at) {
      return [...open.keys()].flatMap((id) => close(id, { status: "cancelled" }, at))
    },
  }
}
