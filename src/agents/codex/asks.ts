// Codex's requests to the user as neutral asks, and the answers YellowCode sends back: approvals of commands, file
// changes and extra permissions, our own ask tool, Codex's own questions, and MCP elicitations.
import type { ClientTool } from "../../agent/agent.ts"
import type { Ask, AskOption, AskOutcome, AskReply, FormField, QuestionPage } from "../../agent/ask.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { AskId, TaskId } from "../../agent/ids.ts"
import type { FileChange, Hunk, ToolKind } from "../../agent/tools.ts"
import { log } from "../../log/log.ts"
import { OWN_ASK } from "../../protocol/messages.ts"
import { NOT_SHOWN, QUESTION_TO_CHAT, SUBAGENT_ASK, TOOL_DECLINED } from "../../protocol/outgoing.ts"
import { ownAskAnswered } from "../../protocol/own-ask-text.ts"
import { ownAskProblem, questionsOf } from "../claude/ask-input.ts"
import { summarizeToolInput } from "../claude/summary.ts"
import { formAnswers } from "../../protocol/form-answers.ts"
import { runClientTool } from "./client-tools.ts"
import { ASK, callOf, fileOf, patchKind } from "./tools.ts"
import type { Translator } from "./translate.ts"
import type { Rpc, RpcId } from "./transport.ts"
import {
  execAmendment,
  networkAmendment,
  readRequest,
  type CommandDecision,
  type Elicitation,
  type ServerRequest,
} from "./wire/requests.ts"

type Events = AgentEvent[]
type Request<M extends ServerRequest["method"]> = Extract<ServerRequest, { method: M }>["params"]

// What an answer sends back to Codex, and what the chat keeps of it.
type Settled = { result: unknown; outcome: AskOutcome }

const ALLOWED: AskOutcome = { status: "allowed" }
const DECLINED: AskOutcome = { status: "denied", said: "", why: "declined", note: "" }

const option = (id: string, effect: AskOption["effect"], lasts: AskOption["lasts"], more: Partial<AskOption> = {}) => ({
  id,
  effect,
  lasts,
  label: null,
  subject: null,
  note: false,
  endsTurn: false,
  mode: null,
  ...more,
})

const NO = option("decline", "deny", "once")

const blank = {
  preview: null,
  writes: [],
  detail: "",
  reason: "",
  questions: null,
  plan: null,
  defaultNo: false,
  safety: false,
  own: null,
}

// The ask a request opens, and how each reply to it is answered; a request it settles at once has no ask.
type Opened = { ask: Ask; settle(reply: AskReply): Settled | null } | { now: unknown; events: Events }

export type Lookup = Pick<Translator, "item" | "subagent" | "mcpCall">

type Context = { lookup: Lookup; thread: string; cwd: string | null; id: AskId }

const byOf = (context: Context, thread: string): TaskId | null =>
  thread === context.thread ? null : context.lookup.subagent(thread)

// The options in Codex's order. `cancel`, which also stops the turn, is left out: one "No" declines, and Codex goes on
// (owner answer 1). Codex 0.165 lists only `cancel` as its no for commands, and takes `decline` too.
function commandOptions(decisions: CommandDecision[]): AskOption[] {
  const options: AskOption[] = []
  let networks = 0
  for (const decision of decisions) {
    if (decision === "accept") options.push(option("accept", "allow", "once"))
    else if (decision === "acceptForSession") options.push(option("acceptForSession", "allow", "session"))
    else if (decision === "decline") options.push(NO)
    else {
      const exec = execAmendment.safeParse(decision).data
      const network = networkAmendment.safeParse(decision).data?.applyNetworkPolicyAmendment.network_policy_amendment
      if (exec) {
        const rule = exec.acceptWithExecpolicyAmendment.execpolicy_amendment.join(" ")
        options.push(option("execpolicy", "allow", "everywhere", { subject: rule, grant: decision }))
      } else if (network) {
        const id = `network-${networks++}`
        const allow = network.action === "allow"
        const label = allow
          ? `Yes, and always allow connections to ${network.host}`
          : `No, and always block connections to ${network.host}`
        options.push(
          option(id, allow ? "allow" : "deny", "everywhere", { label, subject: network.host, grant: decision }),
        )
      }
    }
  }
  if (!options.includes(NO)) options.push(NO)
  return options
}

function commandAsk(params: Request<"item/commandExecution/requestApproval">, context: Context): Opened {
  const known = context.lookup.item(params.itemId)
  const call = known ? callOf(known, context.cwd) : null
  const command = call?.command ?? params.command ?? ""
  const host = params.networkApprovalContext?.host
  const proposed = params.proposedExecpolicyAmendment
  // Without Codex's list, every "always" it takes is offered.
  const fallback: CommandDecision[] = [
    "accept",
    "acceptForSession",
    ...(proposed ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: proposed } }] : []),
    ...(params.proposedNetworkPolicyAmendments ?? []).map((amendment) => ({
      applyNetworkPolicyAmendment: { network_policy_amendment: amendment },
    })),
    "decline",
  ]
  const options = commandOptions(params.availableDecisions ?? fallback)
  const name = call?.name ?? "exec_command"
  const kind: ToolKind = call?.kind ?? "shell"
  return {
    ask: {
      ...blank,
      id: context.id,
      kind: "permission",
      call: params.itemId,
      tool: { name, kind, mcp: null },
      title: call?.title ?? "shell",
      input: { command: params.command ?? null, cwd: params.cwd ?? null },
      target: command || (host ?? ""),
      detail: params.reason ?? "",
      options,
      by: byOf(context, params.threadId),
    },
    settle(reply) {
      if (reply.type !== "option" || reply.option === "decline")
        return { result: { decision: "decline" }, outcome: DECLINED }
      const picked = options.find((one) => one.id === reply.option)
      if (!picked) return null
      const decision = picked.grant ?? picked.id
      return { result: { decision }, outcome: picked.effect === "allow" ? ALLOWED : DECLINED }
    },
  }
}

// A whole file as one hunk: what an added file holds, or what a deleted one held.
function wholeFile(text: string, sign: "+" | "-"): Hunk[] {
  const lines = text.replace(/\n$/, "").split("\n")
  const count = text === "" ? 0 : lines.length
  return sign === "+"
    ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: count, lines: lines.map((line) => `+${line}`) }]
    : [{ oldStart: 1, oldLines: count, newStart: 0, newLines: 0, lines: lines.map((line) => `-${line}`) }]
}

const hunksOfFile = (file: FileChange): Hunk[] =>
  file.patch ?? (file.after !== null ? wholeFile(file.after, "+") : file.before ? wholeFile(file.before, "-") : [])

// The changes come with the fileChange item of the same id, which starts before the request.
function fileAsk(params: Request<"item/fileChange/requestApproval">, context: Context): Opened {
  const known = context.lookup.item(params.itemId)
  const changes = known?.type === "fileChange" ? known.changes : []
  const files = changes.map((change) => fileOf(change, context.cwd))
  const kind = patchKind(files)
  // A yes for the session holds for these files, or for everything under the root Codex names.
  const paths = files.map((file) => file.path).join(", ")
  const session = option("acceptForSession", "allow", "session", { subject: params.grantRoot ?? paths })
  const options = [option("accept", "allow", "once"), session, NO]
  return {
    ask: {
      ...blank,
      id: context.id,
      kind: "permission",
      call: params.itemId,
      tool: { name: "apply_patch", kind, mcp: null },
      title: kind,
      input: { changes },
      target: files.map((file) => (file.movedTo ? `${file.path} → ${file.movedTo}` : file.path)).join("\n"),
      preview: { type: "diff", files: files.map((file) => ({ path: file.path, hunks: hunksOfFile(file) })) },
      writes: files.flatMap((file) => (file.movedTo ? [file.path, file.movedTo] : [file.path])),
      detail: params.reason ?? "",
      options,
      by: byOf(context, params.threadId),
    },
    settle(reply) {
      const decision = reply.type === "option" ? reply.option : "decline"
      if (!options.some((one) => one.id === decision)) return null
      return { result: { decision }, outcome: decision === "decline" ? DECLINED : ALLOWED }
    },
  }
}

// What extra access is asked for, one line each.
function accessLines(permissions: Request<"item/permissions/requestApproval">["permissions"]): string[] {
  const lines: string[] = []
  if (permissions.network?.enabled) lines.push("network access")
  for (const path of permissions.fileSystem?.read ?? []) lines.push(`read ${path}`)
  for (const path of permissions.fileSystem?.write ?? []) lines.push(`write ${path}`)
  return lines
}

// A yes grants all that was asked, for the turn or the session; the no grants nothing.
function permissionsAsk(params: Request<"item/permissions/requestApproval">, context: Context): Opened {
  const { network, fileSystem } = params.permissions
  const granted = { ...(network ? { network } : {}), ...(fileSystem ? { fileSystem } : {}) }
  const lines = accessLines(params.permissions)
  const subject = lines.join(", ")
  const options = [option("turn", "allow", "turn", { subject }), option("session", "allow", "session", { subject }), NO]
  return {
    ask: {
      ...blank,
      id: context.id,
      kind: "permission",
      // The request is a call of the model's, but no item tells it.
      call: null,
      tool: { name: "request_permissions", kind: "other", mcp: null },
      title: "permissions",
      input: { cwd: params.cwd, permissions: params.permissions },
      target: lines.join("\n"),
      detail: params.reason ?? "",
      options,
      by: byOf(context, params.threadId),
    },
    settle(reply) {
      const scope = reply.type === "option" ? reply.option : "decline"
      if (scope === "decline") return { result: { permissions: {}, scope: "turn" }, outcome: DECLINED }
      if (scope !== "turn" && scope !== "session") return null
      return { result: { permissions: granted, scope }, outcome: ALLOWED }
    },
  }
}

const said = (text: string, success: boolean) => ({ contentItems: [{ type: "inputText", text }], success })

// Our own ask tool, for the main thread only; a subagent is told to put its question in its report.
function ownAsk(params: Request<"item/tool/call">, rpcId: RpcId, context: Context): Opened {
  if (params.threadId !== context.thread) return { now: said(SUBAGENT_ASK, false), events: [] }
  const input = params.arguments
  const problem = ownAskProblem({ toolName: OWN_ASK, input })
  if (problem !== null) return { now: said(`${NOT_SHOWN}${problem}.`, false), events: [] }
  return {
    ask: {
      ...blank,
      id: context.id,
      kind: "question",
      call: params.callId,
      tool: { name: ASK, kind: "question", mcp: null },
      title: ASK,
      input,
      target: summarizeToolInput(input),
      options: [],
      questions: questionsOf(OWN_ASK, input),
      by: null,
      own: { handle: rpcId },
    },
    settle(reply) {
      if (reply.type === "answers") {
        const { said: text, answers, notes } = ownAskAnswered(input, reply.answers)
        return { result: said(text, true), outcome: { status: "answered", answers, notes } }
      }
      const chat = reply.type === "declined" && reply.chat
      const text = chat ? QUESTION_TO_CHAT : TOOL_DECLINED
      return {
        result: said(text, false),
        outcome: { status: "denied", said: text, why: chat ? "chat" : "declined", note: "" },
      }
    },
  }
}

const NO_ANSWERS = { answers: {} }

// Codex's own question tool. A question it marks secret is never shown: the whole request is turned down with a
// notice, so no band, store or log sees it.
function questionAsk(params: Request<"item/tool/requestUserInput">, context: Context): Opened {
  const { questions } = params
  const secret = questions.find((question) => question.isSecret)
  if (secret) {
    const text = `Codex asked for a secret answer (${secret.header}). YellowCode does not take secrets, so it said no.`
    return { now: NO_ANSWERS, events: [{ type: "notice", level: "warning", text, at: 0 }] }
  }
  const pages: QuestionPage[] = questions.map((question) => ({
    key: question.id,
    header: question.header,
    question: question.question,
    multi: false,
    gallery: false,
    custom: question.isOther,
    options: (question.options ?? []).map(({ label, description }) => ({
      label,
      description,
      preview: null,
      image: null,
    })),
  }))
  return {
    ask: {
      ...blank,
      id: context.id,
      kind: "question",
      call: null,
      tool: { name: "request_user_input", kind: "question", mcp: null },
      title: "question",
      input: { questions },
      target: questions.map((question) => question.header).join(", "),
      options: [],
      questions: { pages },
      by: byOf(context, params.threadId),
    },
    settle(reply) {
      if (reply.type !== "answers") {
        const chat = reply.type === "declined" && reply.chat
        return {
          result: NO_ANSWERS,
          outcome: { status: "denied", said: "", why: chat ? "chat" : "declined", note: "" },
        }
      }
      const chosen = (key: string) => reply.answers.values[key] ?? []
      const answers = Object.fromEntries(questions.map((question) => [question.id, { answers: chosen(question.id) }]))
      const shown = Object.fromEntries(questions.map((question) => [question.id, chosen(question.id).join(", ")]))
      return { result: { answers }, outcome: { status: "answered", answers: shown, notes: {} } }
    },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" ? value : null)
const count = (value: unknown) => (typeof value === "number" ? value : null)
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((one) => typeof one === "string") : [])

type Choice = { value: string; label: string }

// An enum's choices: `oneOf` / `anyOf` const and title, or `enum` with `enumNames`.
function choicesOf(schema: Record<string, unknown>): Choice[] | null {
  const titled = Array.isArray(schema["oneOf"])
    ? schema["oneOf"]
    : Array.isArray(schema["anyOf"])
      ? schema["anyOf"]
      : null
  if (titled)
    return titled.flatMap((entry) => {
      if (!isRecord(entry) || text(entry["const"]) === null) return []
      const value = String(entry["const"])
      return [{ value, label: text(entry["title"]) ?? value }]
    })
  if (!Array.isArray(schema["enum"])) return null
  const names = strings(schema["enumNames"])
  return strings(schema["enum"]).map((value, index) => ({ value, label: names[index] ?? value }))
}

type Field = { key: string; field: FormField; choices: Choice[] | null; multi: boolean }

const FORMATS = ["email", "uri", "date", "date-time"] as const

// One property of an elicitation's schema as a form field.
function fieldOf(key: string, schema: Record<string, unknown>, required: boolean): Field {
  const title = text(schema["title"]) ?? key
  const base = { key, title, description: text(schema["description"]), required, default: null }
  const items = isRecord(schema["items"]) ? schema["items"] : null
  const multi = schema["type"] === "array" && items !== null
  const choices = choicesOf(multi && items ? items : schema)
  if (choices) {
    const options = choices.map(({ value, label }) => ({ value, label, description: null }))
    const limits = { min: count(schema["minItems"]), max: count(schema["maxItems"]) }
    const control = { type: "choice" as const, multi, options, custom: false, ...limits }
    return { key, field: { ...base, control, when: [] }, choices, multi }
  }
  const type = schema["type"]
  const format = text(schema["format"])
  const control: FormField["control"] =
    type === "boolean"
      ? { type: "toggle" }
      : type === "number" || type === "integer"
        ? { type: "number", integer: type === "integer", min: count(schema["minimum"]), max: count(schema["maximum"]) }
        : {
            type: "text",
            format: FORMATS.find((known) => known === format) ?? null,
            minLength: count(schema["minLength"]),
            maxLength: count(schema["maxLength"]),
            placeholder: null,
          }
  return { key, field: { ...base, control, when: [] }, choices: null, multi: false }
}

const fieldsOf = (schema: unknown): Field[] => {
  if (!isRecord(schema) || !isRecord(schema["properties"])) return []
  const required = new Set(strings(schema["required"]))
  return Object.entries(schema["properties"]).flatMap(([key, inner]) =>
    isRecord(inner) ? [fieldOf(key, inner, required.has(key))] : [],
  )
}

const ACCEPT = (content: unknown) => ({ action: "accept", content, _meta: null })
const DECLINE = { action: "decline", content: null, _meta: null }

// Codex's own "may this MCP tool run?", which it asks as an elicitation with no fields.
function toolApproval(params: Elicitation, meta: Record<string, unknown>, context: Context): Opened {
  const call = context.lookup.mcpCall(params.threadId, params.serverName)
  const known = call ? context.lookup.item(call) : null
  const tool = known?.type === "mcpToolCall" ? known.tool : params.serverName
  const persist = strings(meta["persist"])
  const lasting: [string, AskOption["lasts"]][] = [
    ["session", "session"],
    ["always", "kept"],
  ]
  const options = [
    option("accept", "allow", "once"),
    ...lasting.flatMap(([id, lasts]) => (persist.includes(id) ? [option(id, "allow", lasts, { subject: tool })] : [])),
    NO,
  ]
  return {
    ask: {
      ...blank,
      id: context.id,
      kind: "permission",
      call,
      tool: { name: tool, kind: "mcp", mcp: { server: params.serverName, tool } },
      title: tool,
      input: meta["tool_params"] ?? null,
      target: summarizeToolInput(meta["tool_params"]),
      detail: text(meta["tool_description"]) ?? "",
      options,
      by: byOf(context, params.threadId),
    },
    settle(reply) {
      const picked = reply.type === "option" ? reply.option : "decline"
      if (picked === "decline") return { result: DECLINE, outcome: DECLINED }
      if (picked === "accept") return { result: ACCEPT(null), outcome: ALLOWED }
      if (!options.some((one) => one.id === picked)) return null
      return { result: { action: "accept", content: null, _meta: { persist: picked } }, outcome: ALLOWED }
    },
  }
}

// An MCP server's form. Choice fields are question pages; with none, a form whose fields can all be left out takes a
// plain yes, and one with a required field the band cannot draw only a no (question F's interim, as on opencode).
function formAsk(params: Elicitation, context: Context): Opened {
  const title = params.message ?? params.serverName
  const fields = fieldsOf(params.requestedSchema)
  const pageable = fields.filter((field) => field.choices !== null)
  const pages: QuestionPage[] = pageable.map(({ key, field, choices, multi }) => ({
    key,
    header: field.title,
    question: field.description ?? field.title,
    multi,
    gallery: false,
    custom: false,
    options: (choices ?? []).map(({ label }) => ({ label, description: null, preview: null, image: null })),
  }))
  const unfit = fields.some((field) => field.choices === null && field.field.required)
  const shown = unfit ? [] : pages
  const options = shown.length > 0 ? [] : unfit ? [NO] : [option("accept", "allow", "once"), NO]
  return {
    ask: {
      ...blank,
      id: context.id,
      kind: "question",
      call: context.lookup.mcpCall(params.threadId, params.serverName),
      tool: { name: params.serverName, kind: "question", mcp: null },
      title: params.serverName,
      input: { message: params.message ?? null, requestedSchema: params.requestedSchema ?? null },
      target: title,
      options,
      questions: shown.length > 0 ? { pages: shown } : { form: { title, fields: fields.map((field) => field.field) } },
      by: byOf(context, params.threadId),
    },
    settle(reply) {
      if (reply.type === "option" && reply.option === "accept") return { result: ACCEPT({}), outcome: ALLOWED }
      if (reply.type !== "answers") return { result: DECLINE, outcome: DECLINED }
      const content: Record<string, string | string[]> = {}
      for (const { key, choices, multi } of pageable) {
        const valueOf = (label: string) => choices?.find((choice) => choice.label === label)?.value ?? label
        const chosen = (reply.answers.values[key] ?? []).map(valueOf)
        if (multi) content[key] = chosen
        else if (chosen[0] !== undefined) content[key] = chosen[0]
      }
      return { result: ACCEPT(content), outcome: { status: "answered", answers: formAnswers(content), notes: {} } }
    },
  }
}

// A page the user opens, such as a sign-in; the yes says they will.
function urlAsk(params: Elicitation, context: Context): Opened {
  const url = params.url ?? ""
  const title = params.message ?? params.serverName
  const link: FormField = {
    key: "url",
    title: "Open",
    description: null,
    control: { type: "link", url },
    required: false,
    default: null,
    when: [],
  }
  return {
    ask: {
      ...blank,
      id: context.id,
      kind: "question",
      call: null,
      tool: { name: params.serverName, kind: "question", mcp: null },
      title: params.serverName,
      input: { message: params.message ?? null, url },
      target: url,
      detail: title,
      options: [option("accept", "allow", "once"), NO],
      questions: { form: { title, fields: [link] } },
      by: byOf(context, params.threadId),
    },
    settle(reply) {
      const yes = reply.type === "option" && reply.option === "accept"
      return yes ? { result: ACCEPT(null), outcome: ALLOWED } : { result: DECLINE, outcome: DECLINED }
    },
  }
}

function elicitationAsk(params: Elicitation, context: Context): Opened {
  const meta = isRecord(params["_meta"]) ? params["_meta"] : {}
  if (meta["codex_approval_kind"] === "mcp_tool_call") return toolApproval(params, meta, context)
  if (params.mode === "url") return urlAsk(params, context)
  if (params.mode === "form" || params.mode === "openai/form" || params.mode === "openaiForm")
    return formAsk(params, context)
  const what = params.mode === "openai/userVerification" ? "to verify who you are" : `a ${params.mode} answer`
  const notice = `The ${params.serverName} MCP server asked ${what}. YellowCode cannot answer that, so it said no.`
  return { now: DECLINE, events: [{ type: "notice", level: "warning", text: notice, at: 0 }] }
}

export type AsksDeps = {
  thread: string
  cwd: string | null
  lookup: Lookup
  tools(): readonly ClientTool[]
  tell(events: Events): void
  at(): number
}

export type Asks = {
  // Every request app-server sends: an ask opens, or the request is answered at once.
  request(rpc: Rpc, id: RpcId, method: string, params: unknown): void
  answer(id: AskId, reply: AskReply): void
  // Codex no longer waits for request `id`: answered elsewhere, or its turn ended.
  resolved(rpc: Rpc, id: RpcId): void
  // The app-server is gone, and with it every request that waits.
  gone(): void
}

export function createAsks(deps: AsksDeps): Asks {
  const open = new Map<AskId, { rpc: Rpc; id: RpcId; settle: (reply: AskReply) => Settled | null }>()
  let asked = 0
  const stamped = (events: Events) => deps.tell(events.map((event) => ({ ...event, at: deps.at() })))

  const close = (id: AskId, outcome: AskOutcome) => stamped([{ type: "ask.close", id, outcome, at: 0 }])

  function opened(rpc: Rpc, id: RpcId, made: Opened): void {
    if ("now" in made) {
      rpc.respond(id, made.now)
      if (made.events.length > 0) stamped(made.events)
      return
    }
    open.set(made.ask.id, { rpc, id, settle: (reply) => made.settle(reply) })
    stamped([{ type: "ask.open", ask: made.ask, at: 0 }])
  }

  async function clientTool(rpc: Rpc, id: RpcId, params: Request<"item/tool/call">): Promise<void> {
    const ran = await runClientTool(deps.tools(), params.namespace, params.tool, params.arguments)
    rpc.respond(id, said(ran.text, !ran.error))
  }

  return {
    request(rpc, id, method, params) {
      const read = readRequest(method, params)
      if (read.kind === "unknown") {
        log.warn(`codex: no answer for ${method}`)
        return rpc.fail(id, -32601, `YellowCode does not handle ${method}`)
      }
      if (read.kind === "unreadable") {
        log.warn(`codex: a ${method} is unreadable`)
        stamped([{ type: "unreadable", what: method, at: 0 }])
        return rpc.fail(id, -32602, `YellowCode could not read this ${method}`)
      }
      const { request } = read
      const context: Context = { lookup: deps.lookup, thread: deps.thread, cwd: deps.cwd, id: `codex-${++asked}` }
      switch (request.method) {
        case "item/commandExecution/requestApproval":
          return opened(rpc, id, commandAsk(request.params, context))
        case "item/fileChange/requestApproval":
          return opened(rpc, id, fileAsk(request.params, context))
        case "item/permissions/requestApproval":
          return opened(rpc, id, permissionsAsk(request.params, context))
        case "item/tool/requestUserInput":
          return opened(rpc, id, questionAsk(request.params, context))
        case "mcpServer/elicitation/request":
          return opened(rpc, id, elicitationAsk(request.params, context))
        case "item/tool/call":
          if (request.params.namespace === null && request.params.tool === ASK)
            return opened(rpc, id, ownAsk(request.params, id, context))
          return void clientTool(rpc, id, request.params).catch((error: unknown) => {
            log.error("codex: a client tool failed", error)
          })
      }
    },
    answer(id, reply) {
      const known = open.get(id)
      if (!known) return log.warn("codex: an answer to an ask that is not open")
      const settled = known.settle(reply)
      if (!settled) return log.warn("codex: an answer this ask does not take")
      open.delete(id)
      try {
        known.rpc.respond(known.id, settled.result)
      } catch (error) {
        log.warn("codex: the answer did not go out", String(error))
        return close(id, { status: "cancelled" })
      }
      close(id, settled.outcome)
    },
    resolved(rpc, request) {
      for (const [id, known] of open) {
        if (known.rpc !== rpc || known.id !== request) continue
        open.delete(id)
        close(id, { status: "cancelled" })
      }
    },
    gone() {
      for (const id of open.keys()) {
        open.delete(id)
        close(id, { status: "cancelled" })
      }
    },
  }
}
