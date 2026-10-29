// An earlier opencode session read back for the chat, a page at a time. opencode gives the messages newest first;
// each page is turned around and told by a translator of its own. A subagent's session is read with its call.
/* oxlint-disable no-await-in-loop -- each page names the next */
import { z } from "zod"
import type { HistoryCursor, HistoryPage } from "../../agent/sessions.ts"
import { parseJson } from "../../json.ts"
import { createTranslator, type Children } from "./translate.ts"
import type { Query, Transport } from "./transport.ts"
import { answerOf, dataOf, rawPage, rowsOf } from "./wire/envelope.ts"
import { message, type Message } from "./wire/messages.ts"
import { session } from "./wire/session.ts"

const PAGE = 50
// A page is read on until it starts at a prompt, so no turn is split between two, but no further than this.
const MAX_READS = 10

// No more subagent sessions than this are read for one page.
const MAX_CHILDREN = 50

// `hiding`: the staged revert's prompt, while the walk has not passed it yet. `directory`: the session's folder.
const Cursor = z.object({ next: z.string(), hiding: z.string().nullable(), directory: z.string() })

const childOf = z.looseObject({ sessionID: z.string() })

async function read<T extends z.ZodType>(transport: Transport, path: string, schema: T, query?: Query) {
  const reply = await transport.request({ method: "GET", path, query }).catch(() => null)
  const answer = reply ? answerOf(reply, schema, path) : null
  if (answer?.kind === "ok") return answer.value
  throw new Error(answer?.kind === "error" && answer.message ? answer.message : "opencode did not give the session")
}

function cursorOf(text: HistoryCursor): z.output<typeof Cursor> {
  const json = parseJson(text)
  const parsed = json.ok ? Cursor.safeParse(json.value) : null
  if (!parsed?.success) throw new Error("not an opencode history cursor")
  return parsed.data
}

// A whole session, oldest first.
async function allOf(transport: Transport, id: string): Promise<Message[]> {
  const found: Message[] = []
  let query: Query = { order: "desc", limit: String(PAGE) }
  for (let count = 0; count < MAX_READS; count++) {
    const page = await read(transport, `/api/session/${id}/message`, rawPage, query)
    found.push(...rowsOf(page.data, message, "message"))
    if (page.data.length < PAGE || !page.cursor.next) break
    query = { cursor: page.cursor.next, limit: String(PAGE) }
  }
  return found.toReversed()
}

// The subagent calls among `messages`, with the session each ran.
const calls = (messages: Message[]) =>
  messages.flatMap((entry) =>
    entry.type !== "assistant"
      ? []
      : entry.content.flatMap((part) => {
          if (part.type !== "tool" || part.name !== "subagent" || part.state.status === "streaming") return []
          const child = childOf.safeParse(part.state.metadata).data?.sessionID
          return child === undefined ? [] : [{ call: part.id, session: child }]
        }),
  )

// The sessions the page's subagent calls ran, and theirs in turn, by call.
async function childrenOf(transport: Transport, shown: Message[]): Promise<Children> {
  const children: Children = new Map()
  const waiting = calls(shown)
  while (waiting.length > 0 && children.size < MAX_CHILDREN) {
    const next = waiting.shift()
    if (!next || children.has(next.call)) continue
    const found = await allOf(transport, next.session).catch(() => [])
    children.set(next.call, found)
    waiting.push(...calls(found))
  }
  return children
}

export async function historyPage(
  transport: Transport,
  id: string,
  cursor: HistoryCursor | null,
  size = PAGE,
): Promise<HistoryPage> {
  const base = `/api/session/${id}`
  const from = cursor === null ? null : cursorOf(cursor)
  // While a revert is staged, opencode still lists what it would drop: the staged prompt and everything after it.
  const info = from ? null : (await read(transport, base, dataOf(session))).data
  let hiding = from ? from.hiding : (info?.revert?.messageID ?? null)
  const directory = from ? from.directory : (info?.location.directory ?? "")
  let query: Query = from ? { cursor: from.next, limit: String(size) } : { order: "desc", limit: String(size) }
  const shown: Message[] = []
  let next: string | null = null
  for (let count = 0; count < MAX_READS; count++) {
    const found = await read(transport, `${base}/message`, rawPage, query)
    for (const row of rowsOf(found.data, message, "message")) {
      if (hiding === null) shown.push(row)
      else if (row.type !== "unknown" && row.id === hiding) hiding = null
    }
    next = found.data.length < size ? null : (found.cursor.next ?? null)
    if (next === null || shown.at(-1)?.type === "user") break
    query = { cursor: next, limit: String(size) }
  }
  const oldest = shown.toReversed()
  const translator = createTranslator()
  translator.within(directory)
  return {
    events: translator.readBack(oldest, await childrenOf(transport, oldest)),
    earlier: next === null ? null : JSON.stringify({ next, hiding, directory }),
  }
}
