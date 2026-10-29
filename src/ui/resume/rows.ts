import type { AgentKindId } from "../../agent/ids.ts"
import type { SessionEntry } from "../../agent/sessions.ts"
import { formatAgo, pad } from "../format.ts"

// `names` are the agents' names for the rows; null while one agent is listed, whose rows show no name.
export type SessionList = { entries: SessionEntry[]; names: Record<AgentKindId, string> | null }

const widest = (texts: string[]) => Math.max(0, ...texts.map((text) => Bun.stringWidth(text)))

// The time a row shows on its right, after its agent's name when rows are named; both in columns the rows share.
export function rowEnd(list: SessionList, now: number): (entry: SessionEntry) => string {
  const { names } = list
  if (!names) return (entry) => formatAgo(entry.modified, now)
  const nameOf = (entry: SessionEntry) => names[entry.ref.agent] ?? entry.ref.agent
  const nameWidth = widest(list.entries.map(nameOf))
  const agoWidth = widest(list.entries.map((entry) => formatAgo(entry.modified, now)))
  return (entry) => `${pad(nameOf(entry), nameWidth)}  ${formatAgo(entry.modified, now).padStart(agoWidth)}`
}
