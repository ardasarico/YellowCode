// Makes a recording machine-independent before it is written: the root becomes <root>, ports become names, and
// opencode's random ids become per-prefix counters in order of first appearance (so their sort order is not kept).

export type ScrubContext = {
  root: string
  home: string
  host: string
  // A port and the name it gets, e.g. the service's and the mock's.
  ports: [number, string][]
}

// opencode ids: a prefix, 12 hex digits of time and counter, 14 random characters. A fork's copies add `_<n>`.
const ID = /\b([a-z]{2,6})_([0-9a-f]{12}[0-9A-Za-z]{14})(?![0-9A-Za-z])/g
// List cursors are base64url JSON that carries a message id.
const CURSOR = /"(eyJ[A-Za-z0-9_-]+)"/g

export function createScrubber(context: ScrubContext): (line: unknown) => string {
  const ids = new Map<string, string>()
  const counts = new Map<string, number>()
  const swaps: [string, string][] = [
    [context.root, "<root>"],
    [context.root.replace(/^\/private/, ""), "<root>"],
    [context.home, "<home>"],
    ...context.ports.map(([port, name]): [string, string] => [`127.0.0.1:${port}`, `127.0.0.1:<${name}>`]),
  ]
  if (context.host.length >= 4) swaps.push([context.host, "<host>"])

  const rename = (text: string) =>
    text.replace(ID, (whole, prefix: string) => {
      const known = ids.get(whole)
      if (known) return known
      const n = (counts.get(prefix) ?? 0) + 1
      counts.set(prefix, n)
      const renamed = `${prefix}_${n}`
      ids.set(whole, renamed)
      return renamed
    })

  return (line) => {
    let text = JSON.stringify(line)
    for (const [from, to] of swaps) text = text.replaceAll(from, to)
    text = rename(text)
    return text.replace(CURSOR, (_, cursor: string) => {
      const inner = rename(Buffer.from(cursor, "base64url").toString("utf8"))
      return JSON.stringify(Buffer.from(inner, "utf8").toString("base64url"))
    })
  }
}
