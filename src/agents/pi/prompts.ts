// Pi keeps no id of ours with a user message, so YellowCode keeps one file per pi session that maps the message's
// entry id to the prompt id it went out with. Rewind snapshots are keyed by that prompt id, and a fork keeps the
// entry ids, so a resumed or forked session finds them again.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { PromptId } from "../../agent/ids.ts"
import { parseJson } from "../../json.ts"
import { log } from "../../log/log.ts"

const SAFE_ID = /^[\w-]+$/
const stored = z.record(z.string(), z.string())

export type PromptMap = {
  // Prompt ids by entry id, for the session.
  read(session: string): Map<string, PromptId>
  add(session: string, pairs: [string, PromptId][]): void
}

export function promptMap(dir: string): PromptMap {
  const file = (session: string) => (SAFE_ID.test(session) ? join(dir, `${session}.json`) : null)
  function read(session: string): Map<string, PromptId> {
    const path = file(session)
    if (path === null) return new Map()
    try {
      const json = parseJson(readFileSync(path, "utf8"))
      const parsed = json.ok ? stored.safeParse(json.value) : null
      return new Map(parsed?.success ? Object.entries(parsed.data) : [])
    } catch {
      return new Map()
    }
  }
  return {
    read,
    add(session, pairs) {
      const path = file(session)
      if (path === null || pairs.length === 0) return
      const known = read(session)
      for (const [entry, prompt] of pairs) known.set(entry, prompt)
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(path, JSON.stringify(Object.fromEntries(known)))
      } catch (error) {
        log.warn("pi: could not keep the prompt ids", error)
      }
    },
  }
}
