// After a reconnect, or when our session's durable sequence skips, the stream may have missed events. A resync reads
// the session as opencode stored it and lets the translator tell what it had not told yet.
import { z } from "zod"
import type { AgentEvent } from "../../agent/events.ts"
import { log } from "../../log/log.ts"
import type { Cuts } from "./cut.ts"
import type { Translator } from "./translate.ts"
import type { Query, Transport } from "./transport.ts"
import { form, permissionRequest } from "./wire/asks.ts"
import { answerOf, dataOf, rawPage, rowsOf, type Answer } from "./wire/envelope.ts"
import { message, type Message } from "./wire/messages.ts"
import { session as sessionSchema } from "./wire/session.ts"

const PAGE = "20"
const MAX_PAGES = 10

const list = z.looseObject({ data: z.array(z.unknown()) })
const active = dataOf(z.record(z.string(), z.unknown()))
const shell = dataOf(z.looseObject({ status: z.string(), exit: z.number().optional() }))
const output = dataOf(z.looseObject({ output: z.string(), size: z.number(), truncated: z.boolean() }))

async function ask<T extends z.ZodType>(
  transport: Transport,
  path: string,
  schema: T,
  query?: Query,
): Promise<Answer<z.output<T>> | null> {
  const reply = await transport.request({ method: "GET", path, query }).catch(() => null)
  return reply ? answerOf(reply, schema, path) : null
}

function valueOf<T>(answer: Answer<T> | null, path: string): T | null {
  if (!answer) return null
  if (answer.kind === "ok") return answer.value
  log.warn(`opencode: resync could not read ${path} (${answer.kind === "error" ? answer.status : "unreadable"})`)
  return null
}

const read = async <T extends z.ZodType>(transport: Transport, path: string, schema: T, query?: Query) =>
  valueOf(await ask(transport, path, schema, query), path)

// Newest first, until the page that holds `boundary`.
async function messagesSince(transport: Transport, path: string, boundary: string | null): Promise<Message[] | null> {
  const found: Message[] = []
  let query: Query = { order: "desc", limit: PAGE }
  for (let count = 0; count < MAX_PAGES; count++) {
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const next = await read(transport, path, rawPage, query)
    if (!next) return null
    found.push(...rowsOf(next.data, message, "message"))
    if (boundary !== null && found.some((item) => "id" in item && item.id === boundary)) break
    if (!next.cursor.next) break
    query = { cursor: next.cursor.next, limit: PAGE }
  }
  const at = found.findIndex((item) => "id" in item && item.id === boundary)
  return (at < 0 ? found : found.slice(0, at + 1)).toReversed()
}

// A background shell's output, read once when it exited.
export async function shellOutput(transport: Transport, id: string, at: number): Promise<AgentEvent[]> {
  const found = await read(transport, `/api/shell/${id}/output`, output)
  if (!found) return []
  const { data } = found
  return [{ type: "task.output", id, text: data.output, bytes: data.size, truncated: data.truncated, at }]
}

// A session's message list does not say when a background shell ends, so each one the stream left running is asked
// about. One opencode no longer knows was removed.
async function shellsEnded(transport: Transport, translator: Translator, at: number): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for (const id of translator.runningShells()) {
    const path = `/api/shell/${id}`
    // oxlint-disable-next-line no-await-in-loop -- few shells, asked one at a time
    const asked = await ask(transport, path, shell)
    if (asked?.kind === "error" && asked.tag === "ShellNotFoundError") {
      events.push(...translator.shellFound(id, "gone", at))
      continue
    }
    const found = valueOf(asked, path)
    if (!found || found.data.status === "running") continue
    events.push(...translator.shellFound(id, found.data, at))
    // oxlint-disable-next-line no-await-in-loop -- the output of the shell just found
    if (found.data.status !== "killed") events.push(...(await shellOutput(transport, id, at)))
  }
  return events
}

// What was missed, or nothing when opencode could not be read; the next resync tries again.
export async function resync(
  transport: Transport,
  id: string,
  translator: Translator,
  cuts: Cuts,
  at: number,
): Promise<AgentEvent[]> {
  const base = `/api/session/${id}`
  const asked = await ask(transport, base, dataOf(sessionSchema))
  // Deleted from another client while the stream was down.
  if (asked?.kind === "error" && asked.tag === "SessionNotFoundError") return translator.deleted(at)
  const info = valueOf(asked, base)
  if (!info) return []
  // A stage no longer held was cleared or committed. A commit deleted its message, which then is not read from again,
  // and the span goes for good.
  const revert = info.data.revert?.messageID ?? null
  const staged = cuts.staged()
  const final: AgentEvent[] = []
  if (staged !== null && staged !== revert) {
    const kept = await ask(transport, `${base}/message/${staged}`, z.unknown())
    if (kept?.kind === "error" && kept.tag === "MessageNotFoundError") final.push(...cuts.committedElsewhere(at))
  }
  // Told first, so a turn the resync finds opencode ran on a shell's end takes that end in.
  const ended = [...final, ...(await shellsEnded(transport, translator, at))]
  const messages = await messagesSince(transport, `${base}/message`, translator.boundary())
  if (!messages) return ended
  const running = await read(transport, "/api/session/active", active)
  const permissions = await read(transport, `${base}/permission`, list)
  const forms = await read(transport, `${base}/form`, list)
  if (!running || !permissions || !forms) return ended
  const found = translator.resynced({
    title: info.data.title ?? null,
    agent: info.data.agent,
    model: info.data.model,
    cost: info.data.cost,
    messages,
    running: id in running.data,
    outcome: info.data.outcome ?? null,
    permissions: rowsOf(permissions.data, permissionRequest, "permission request"),
    forms: rowsOf(forms.data, form, "form"),
    at,
  })
  // A cut another client made or took back meanwhile, once the prompt it names is told.
  return [...ended, ...found, ...cuts.found(revert, at)]
}
