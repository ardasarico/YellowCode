// The threads of one folder, for /resume and Recent.
/* oxlint-disable no-await-in-loop -- each page names the next */
import type { SessionEntry } from "../../agent/sessions.ts"
import { withoutHandoff } from "../../session/handoff.ts"
import { oneLine } from "../../session/tool-summary.ts"
import { CODEX } from "./caps.ts"
import type { Rpc } from "./transport.ts"
import { page, resultOf, thread, type Thread } from "./wire/thread.ts"

const PAGE = 50
const MAX_PAGES = 20

// Top-level threads of `cwd`, newest first. Codex lists interactive sources only, so subagent threads are left out
// already; the check here keeps a version that lists them from showing them.
export async function listSessions(rpc: Rpc, cwd: string): Promise<SessionEntry[]> {
  const found: Thread[] = []
  let cursor: string | null = null
  for (let count = 0; count < MAX_PAGES; count++) {
    const listed: unknown = await rpc.request("thread/list", {
      cwd,
      sortKey: "updated_at",
      limit: PAGE,
      ...(cursor === null ? {} : { cursor }),
    })
    const reply = resultOf(listed, page, "thread/list")
    if (reply.kind !== "ok") throw new Error("Codex did not list its sessions")
    for (const row of reply.value.data) {
      const parsed = thread.safeParse(row)
      if (parsed.success) found.push(parsed.data)
    }
    cursor = reply.value.nextCursor
    if (cursor === null) break
  }
  // After a revert Codex lists a thread once more for the part written since, newest first; the oldest part's preview is
  // the thread's first prompt.
  const first = new Map(found.map((row) => [row.id, withoutHandoff(row.preview)]))
  const seen = new Set<string>()
  return found
    .filter((row) => !row.parentThreadId && !row.ephemeral && row.cwd === cwd)
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .filter((row) => !seen.has(row.id) && seen.add(row.id))
    .map((row) => ({
      ref: { agent: CODEX, id: row.id },
      title: oneLine(row.name ?? "") || oneLine(first.get(row.id) ?? row.preview),
      firstPrompt: oneLine(first.get(row.id) ?? row.preview),
      cwd: row.cwd,
      branch: row.gitInfo?.branch ?? null,
      model: row.model ? { provider: row.modelProvider ?? null, id: row.model } : null,
      modified: row.updatedAt * 1000,
    }))
}
