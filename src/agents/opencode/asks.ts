// opencode's permission requests and forms as neutral asks, and the replies YellowCode sends for them.
import type { Ask, AskOption, AskOutcome, AskReply, FormField as NeutralField, QuestionPage } from "../../agent/ask.ts"
import type { TaskId, ToolId } from "../../agent/ids.ts"
import { absolute, kindOf } from "./tools.ts"
import type { Form, FormField, PermissionRequest } from "./wire/asks.ts"

const blankAsk = () => ({
  preview: null,
  writes: [],
  detail: "",
  reason: "",
  questions: null,
  plan: null,
  defaultNo: false,
  safety: false,
  by: null,
  own: null,
})

const DECISIONS = ["once", "always", "reject"] as const
type Decision = (typeof DECISIONS)[number]

// What a permission ask knows beyond the request: its call and the call's tool, if the stream told them, and the
// subagent that asks.
export type AskFrom = { call: ToolId | null; tool: string | null; by: TaskId | null; directory: string }

// The option ids are opencode's own decisions. A no takes a note, which opencode gives the model; without one it
// stops the turn.
export function permissionAsk(request: PermissionRequest, from: AskFrom): Ask {
  const save = request.save ?? []
  const name = from.tool ?? request.action
  const kind = kindOf(name)
  const writes = [kind, kindOf(request.action)].some((known) => known === "edit" || known === "write")
  const option = (id: Decision, effect: "allow" | "deny", lasts: "once" | "project") => ({
    id,
    effect,
    lasts,
    label: null,
    subject: id === "always" ? save.join(", ") : null,
    note: id === "reject",
    endsTurn: false,
    mode: null,
    ...(id === "always" ? { grant: save } : {}),
  })
  return {
    ...blankAsk(),
    id: request.id,
    kind: "permission",
    call: from.call,
    tool: { name, kind, mcp: null },
    title: name,
    input: { resources: request.resources },
    target: request.resources.join("\n"),
    writes: writes ? request.resources.map((path) => absolute(path, from.directory)) : [],
    by: from.by,
    options: [
      option("once", "allow", "once"),
      ...(save.length > 0 ? [option("always", "allow", "project")] : []),
      option("reject", "deny", "once"),
    ],
  }
}

// The body of `POST .../permission/{id}/reply`; null for a reply a permission does not take.
export function permissionReply(reply: AskReply): { decision: Decision; message?: string } | null {
  if (reply.type === "declined") return { decision: "reject" }
  if (reply.type !== "option") return null
  const decision = DECISIONS.find((known) => known === reply.option)
  if (!decision) return null
  const note = reply.note?.trim() ?? ""
  return decision === "reject" && note ? { decision, message: note } : { decision }
}

// `note`: what the user said with a no, when YellowCode sent it.
export function permissionOutcome(reply: string, note = ""): AskOutcome {
  return reply === "reject" ? { status: "denied", said: note, why: "declined", note } : { status: "allowed" }
}

const limit = (value: number | string | undefined) => (typeof value === "number" ? value : null)

const choices = (options: { value: string; label?: string; description?: string }[]) =>
  options.map(({ value, label, description }) => ({ value, label: label ?? value, description: description ?? null }))

function control(field: FormField): NeutralField["control"] {
  if (field.type === "string")
    return field.options
      ? {
          type: "choice",
          multi: false,
          options: choices(field.options),
          custom: field.custom ?? false,
          min: null,
          max: null,
        }
      : {
          type: "text",
          format: field.format ?? null,
          minLength: field.minLength ?? null,
          maxLength: field.maxLength ?? null,
          placeholder: field.placeholder ?? null,
        }
  if (field.type === "number" || field.type === "integer")
    return { type: "number", integer: field.type === "integer", min: limit(field.minimum), max: limit(field.maximum) }
  if (field.type === "boolean") return { type: "toggle" }
  if (field.type === "multiselect")
    return {
      type: "choice",
      multi: true,
      options: choices(field.options),
      custom: field.custom ?? false,
      min: field.minItems ?? null,
      max: field.maxItems ?? null,
    }
  return { type: "link", url: field.url }
}

function defaultOf(field: FormField): NeutralField["default"] {
  if (field.type === "external" || field.default === undefined) return null
  return field.type === "number" || field.type === "integer" ? limit(field.default) : field.default
}

// A string with options is one choice and a multiselect several, each on a page filed under its field key. Fields that
// fit no page (text, number, toggle, link) are left out until owner question F says how to show them.
export function formPages(form: Form): QuestionPage[] {
  return form.fields.flatMap((field) => {
    if (field.hidden || (field.type !== "string" && field.type !== "multiselect")) return []
    const options = field.options
    if (!options) return []
    const title = field.title ?? field.key
    return [
      {
        key: field.key,
        header: title,
        question: field.description ?? title,
        multi: field.type === "multiselect",
        gallery: false,
        custom: field.custom ?? false,
        options: options.map((option) => ({
          label: option.label ?? option.value,
          description: option.description ?? null,
          preview: null,
          image: null,
        })),
      },
    ]
  })
}

// A form with no field a page can show, or with a required one it cannot, keeps its fields for later and offers only a
// no, which dismisses it: opencode refuses an answer that leaves out a required field.
const DISMISS: AskOption = {
  id: "dismiss",
  effect: "deny",
  lasts: "once",
  label: null,
  subject: null,
  note: false,
  endsTurn: true,
  mode: null,
}

export function formAsk(form: Form): Ask {
  const shown = formPages(form)
  const keys = new Set(shown.map((page) => page.key))
  const missing = form.fields.some(
    (field) => !field.hidden && field.type !== "external" && field.required && !keys.has(field.key),
  )
  const pages = missing ? [] : shown
  const fields = form.fields
    .filter((field) => !field.hidden)
    .map((field): NeutralField => ({
      key: field.key,
      title: field.title ?? field.key,
      description: field.description ?? null,
      control: control(field),
      required: field.type !== "external" && (field.required ?? false),
      default: defaultOf(field),
      when: field.type === "external" ? [] : (field.when ?? []),
    }))
  return {
    ...blankAsk(),
    id: form.id,
    kind: "question",
    call: form.metadata?.tool?.id ?? null,
    tool: { name: "question", kind: "question", mcp: null },
    title: form.title,
    input: { fields: form.fields },
    target: form.title,
    options: pages.length > 0 ? [] : [DISMISS],
    questions: pages.length > 0 ? { pages } : { form: { title: form.title, fields } },
  }
}

// The body of `POST .../form/{id}/reply`, keyed by field key with each option's value; "dismiss" for a reply that
// leaves the form, which opencode takes as the end of the turn. A typed answer goes as typed. Notes have no place in a
// form and are not sent.
export function formReply(form: Form, reply: AskReply): { answer: Record<string, string | string[]> } | "dismiss" {
  if (reply.type !== "answers") return "dismiss"
  const answer: Record<string, string | string[]> = {}
  for (const field of form.fields) {
    const chosen = reply.answers.values[field.key]
    if (!chosen || (field.type !== "string" && field.type !== "multiselect")) continue
    const valueOf = (label: string) =>
      field.options?.find((option) => (option.label ?? option.value) === label)?.value ?? label
    if (field.type === "multiselect") answer[field.key] = chosen.map(valueOf)
    else if (chosen[0] !== undefined) answer[field.key] = valueOf(chosen[0])
  }
  return { answer }
}
