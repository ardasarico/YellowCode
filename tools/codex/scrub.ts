// Makes a recording machine-independent before it is written: the root becomes <root>, the home folder, user and
// host names become placeholders, ports become names, `userAgent` keeps only Codex's name and version, and UUIDs
// (thread, turn and item ids) become counters in order of first appearance.
import { PROMPT_IN_JSON } from "../../src/agent/yellowcode-prompt.ts"

export type ScrubContext = {
  root: string
  home: string
  user: string
  host: string
  // A port and the name it gets, e.g. the mock's.
  ports: [number, string][]
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

function withAgent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withAgent)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      key === "userAgent" && typeof inner === "string" ? (inner.split(" ")[0] ?? "") : withAgent(inner),
    ]),
  )
}

export function createScrubber(context: ScrubContext): (line: unknown) => string {
  const ids = new Map<string, string>()
  const swaps: [string, string][] = [
    [context.root, "<root>"],
    [context.root.replace(/^\/private/, ""), "<root>"],
    [context.home, "<home>"],
    ...context.ports.map(([port, name]): [string, string] => [`127.0.0.1:${port}`, `127.0.0.1:<${name}>`]),
  ]
  // Short names would hit ordinary words.
  swaps.push([PROMPT_IN_JSON, "<yellowcode>"])
  if (context.host.length >= 4) swaps.push([context.host, "<host>"])
  if (context.user.length >= 4) swaps.push([context.user, "<user>"])

  return (line) => {
    let text = JSON.stringify(withAgent(line))
    for (const [from, to] of swaps) text = text.replaceAll(from, to)
    return text.replace(UUID, (whole) => {
      const key = whole.toLowerCase()
      const known = ids.get(key)
      if (known) return known
      const renamed = `00000000-0000-7000-8000-${String(ids.size + 1).padStart(12, "0")}`
      ids.set(key, renamed)
      return renamed
    })
  }
}
