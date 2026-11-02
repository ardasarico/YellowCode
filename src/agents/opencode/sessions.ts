// The sessions of one folder on opencode's shared service, for /resume and Recent.
/* oxlint-disable no-await-in-loop -- each page names the next, and the prompts are read a few at a time */
import type { SessionEntry } from "../../agent/sessions.ts"
import { oneLine } from "../../session/tool-summary.ts"
import { OPENCODE } from "./caps.ts"
import { isChild } from "./leftovers.ts"
import type { Query, Transport } from "./transport.ts"
import { answerOf, rawPage, rowsOf } from "./wire/envelope.ts"
import { message } from "./wire/messages.ts"
import { session, type Session } from "./wire/session.ts"

const PAGE = "50"
const MAX_PAGES = 20
// The first prompts are read in parallel, this many at a time; 44 of them took 6 to 10 ms in all.
const READERS = 8

async function page(transport: Transport, path: string, query: Query) {
  const reply = await transport.request({ method: "GET", path, query }).catch(() => null)
  const answer = reply ? answerOf(reply, rawPage, path) : null
  return answer?.kind === "ok" ? answer.value : null
}

// The session's first prompt, false when it has none, or null when it cannot be read.
async function firstPrompt(transport: Transport, id: string): Promise<string | false | null> {
  const found = await page(transport, `/api/session/${id}/message`, { type: "user", order: "asc", limit: "1" })
  if (!found) return null
  const [first] = rowsOf(found.data, message, "message")
  return first?.type === "user" ? first.text : false
}

async function firstPrompts(transport: Transport, ids: string[]): Promise<(string | false | null)[]> {
  const prompts: (string | false | null)[] = []
  let next = 0
  const reader = async () => {
    while (next < ids.length) {
      const index = next++
      prompts[index] = await firstPrompt(transport, ids[index] ?? "")
    }
  }
  await Promise.all(Array.from({ length: READERS }, reader))
  return prompts
}

// Top-level sessions of `cwd` that are not archived and not a YellowCode subagent's, newest first. The service filters them already; the check here
// keeps a version that ignores a filter from listing subagent runs or other folders.
export async function listSessions(transport: Transport, cwd: string): Promise<SessionEntry[]> {
  const found: Session[] = []
  let query: Query = { directory: cwd, parentID: "null", archived: "false", order: "desc", limit: PAGE }
  for (let count = 0; count < MAX_PAGES; count++) {
    const next = await page(transport, "/api/session", query)
    if (!next) throw new Error("opencode did not list its sessions")
    found.push(...rowsOf(next.data, session, "session"))
    const cursor = next.cursor.next
    if (!cursor || next.data.length < Number(PAGE)) break
    query = { cursor, limit: PAGE }
  }
  const shown = found.filter(
    (row) =>
      row.parentID === undefined &&
      row.time.archived === undefined &&
      row.location.directory === cwd &&
      !isChild(row.title),
  )
  const prompts = await firstPrompts(
    transport,
    shown.map((row) => row.id),
  )
  // A session nobody prompted yet is left out, as Claude's list does; one whose prompt could not be read stays.
  return shown
    .flatMap((row, index) => {
      const prompt = prompts[index]
      if (prompt === false) return []
      const entry: SessionEntry = {
        ref: { agent: OPENCODE, id: row.id },
        title: oneLine(row.title) || oneLine(prompt ?? ""),
        firstPrompt: oneLine(prompt ?? ""),
        cwd: row.location.directory,
        branch: null,
        model: row.model ? { provider: row.model.providerID, id: row.model.id } : null,
        modified: row.time.updated,
      }
      return [entry]
    })
    .toSorted((a, b) => b.modified - a.modified)
}
