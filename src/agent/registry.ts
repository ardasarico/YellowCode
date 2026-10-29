import { log } from "../log/log.ts"
import type { AgentKind } from "./agent.ts"
import type { AgentKindId } from "./ids.ts"
import type { SessionEntry, SessionRef } from "./sessions.ts"

// What the app uses of an installed agent outside a running session: the session lists and a saved session's view.
export type SessionKind = Pick<
  AgentKind,
  "id" | "name" | "shortName" | "caps" | "sessions" | "history" | "settingChange" | "settingMessage"
>

// So that an agent whose service is slow to come up does not hold back the others' sessions.
const LIST_MS = 3_000

const within = <T>(list: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    list,
    Bun.sleep(ms).then(() => {
      throw new Error(`no answer in ${ms} ms`)
    }),
  ])

// The agents installed here.
export function createRegistry(kinds: SessionKind[], waitMs = LIST_MS) {
  return {
    // Every installed agent's sessions for the folder, merged newest first. An agent whose list cannot be read, or
    // takes longer than `waitMs`, is left out, unless none can be read. The running agent's list is waited for.
    async sessions(cwd: string, running: AgentKindId | null = null): Promise<SessionEntry[]> {
      const lists = await Promise.allSettled(
        kinds.map((kind) => (kind.id === running ? kind.sessions(cwd) : within(kind.sessions(cwd), waitMs))),
      )
      const read = lists.flatMap((list) => (list.status === "fulfilled" ? [list.value] : []))
      const [first] = lists
      if (read.length === 0 && first?.status === "rejected") throw first.reason
      lists.forEach((list, i) => {
        if (list.status === "rejected") log.warn(`${kinds[i]?.id} sessions could not be read`, String(list.reason))
      })
      return read.flat().toSorted((a, b) => b.modified - a.modified)
    },
    kindOf(ref: SessionRef): SessionKind {
      const kind = kinds.find((candidate) => candidate.id === ref.agent)
      if (!kind) throw new Error(`no installed agent ${ref.agent}`)
      return kind
    },
  }
}
