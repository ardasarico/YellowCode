// A session YellowCode does not keep carries a marker with the pid of the YellowCode that made it, as the end of its
// title. Closing deletes it; one whose YellowCode is gone (a crash) is deleted by the next one that starts opencode.
/* oxlint-disable no-await-in-loop -- each page names the next */
import { log } from "../../log/log.ts"
import type { Query, Transport } from "./transport.ts"
import { answerOf, rawPage, rowsOf } from "./wire/envelope.ts"
import { session } from "./wire/session.ts"

const SEARCH = "yc-child:"
const MARKED = /\(yc-child:(\d+)\)$/
const PAGE = "50"
const MAX_PAGES = 20

export const childTitle = (title = "YellowCode subagent", pid = process.pid) => `${title} (${SEARCH}${pid})`

export const isChild = (title: string | undefined) => title !== undefined && MARKED.test(title)

// A pid this user cannot signal belongs to someone, so it counts as running.
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

export async function deleteSession(transport: Transport, id: string): Promise<boolean> {
  const reply = await transport.request({ method: "DELETE", path: `/api/session/${id}` }).catch(() => null)
  return reply !== null && reply.status >= 200 && reply.status < 300
}

// Every folder's marked sessions whose YellowCode no longer runs.
export async function deleteLeftovers(transport: Transport): Promise<void> {
  const left: string[] = []
  let query: Query = { search: SEARCH, limit: PAGE }
  for (let count = 0; count < MAX_PAGES; count++) {
    const reply = await transport.request({ method: "GET", path: "/api/session", query }).catch(() => null)
    const answer = reply ? answerOf(reply, rawPage, "/api/session") : null
    if (answer?.kind !== "ok") return
    for (const row of rowsOf(answer.value.data, session, "session")) {
      const pid = MARKED.exec(row.title ?? "")?.[1]
      if (pid !== undefined && !running(Number(pid))) left.push(row.id)
    }
    const cursor = answer.value.cursor.next
    if (!cursor || answer.value.data.length < Number(PAGE)) break
    query = { cursor, limit: PAGE }
  }
  for (const id of left) if (!(await deleteSession(transport, id))) log.warn("opencode: a leftover session stayed")
  if (left.length > 0) log.info("opencode: leftover sessions deleted", { count: left.length })
}
