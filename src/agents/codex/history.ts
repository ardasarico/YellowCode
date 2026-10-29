// An earlier thread read back for the chat, a page of turns at a time, newest page first. Each turn opens with its
// prompt, so no page splits one.
import type { PromptId } from "../../agent/ids.ts"
import type { HistoryCursor, HistoryPage } from "../../agent/sessions.ts"
import { createTranslator, promptOf } from "./translate.ts"
import type { Rpc } from "./transport.ts"
import { page, resultOf, turn, type Turn } from "./wire/thread.ts"

const PAGE = 20
// A copy before a prompt looks this many turns back for it.
const MAX_PAGES = 50

async function turnsPage(rpc: Rpc, threadId: string, cursor: string | null, size: number) {
  const reply = resultOf(
    await rpc.request("thread/turns/list", {
      threadId,
      limit: size,
      sortDirection: "desc",
      itemsView: "full",
      ...(cursor === null ? {} : { cursor }),
    }),
    page,
    "thread/turns/list",
  )
  if (reply.kind !== "ok") throw new Error("Codex did not give the session")
  const turns = reply.value.data.flatMap((row) => {
    const parsed = turn.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
  return { turns, next: reply.value.nextCursor }
}

export async function historyPage(
  rpc: Rpc,
  threadId: string,
  cursor: HistoryCursor | null,
  size = PAGE,
): Promise<HistoryPage> {
  const { turns, next } = await turnsPage(rpc, threadId, cursor, size)
  return { events: createTranslator(threadId).readBack(turns.toReversed()), earlier: next }
}

const opens = (found: Turn, prompt: PromptId) =>
  found.items.some((item) => item.type === "userMessage" && promptOf(item) === prompt)

// The turn `prompt` went into, for a copy that starts before it.
export async function turnOf(rpc: Rpc, threadId: string, prompt: PromptId): Promise<string> {
  let cursor: string | null = null
  for (let count = 0; count < MAX_PAGES; count++) {
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const { turns, next } = await turnsPage(rpc, threadId, cursor, PAGE)
    const found = turns.find((one) => opens(one, prompt))
    if (found) return found.id
    if (next === null) break
    cursor = next
  }
  throw new Error("Codex has no such prompt in the session")
}
