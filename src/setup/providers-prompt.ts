import type { AgentKindId } from "../agent/ids.ts"

// A provider the list offers. `blocked` says why it cannot be added, such as "needs opencode 2".
export type ProviderRow = { id: AgentKindId; name: string; version: string | null; blocked: string | null }

const QUESTION = "Which providers should YellowCode use?"
const HINT = "↑↓ move · space select · enter continue"
const LATER = "You can change this later with /providers."
const NONE = "Select at least one provider."

const UP = ["\x1b[A", "\x1bOA", "k"]
const DOWN = ["\x1b[B", "\x1bOB", "j"]
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`

// Asks in the plain terminal which providers to use, `checked` already selected; null when the user quits with Ctrl+C.
export function askProviders(rows: ProviderRow[], checked: AgentKindId[]): Promise<AgentKindId[] | null> {
  const { stdin, stdout } = process
  const selected = new Set(checked.filter((id) => rows.some((row) => row.id === id)))
  const movable = rows.flatMap((row, index) => (row.blocked === null ? [index] : []))
  let at = movable[0] ?? 0
  let problem = false
  let drawn = 0
  const width = Math.max(...rows.map((row) => row.name.length))

  function line(row: ProviderRow, index: number): string {
    const pointer = index === at ? "❯" : " "
    const version = row.version === null ? "" : `  ${row.version}`
    const mark = selected.has(row.id) ? "◉" : "◯"
    if (row.blocked !== null) return dim(`${pointer} ${mark} ${row.name.padEnd(width)}${version} · ${row.blocked}`)
    return `${pointer} ${mark} ${row.name.padEnd(width)}${dim(version)}`
  }

  function draw(): void {
    const lines = [QUESTION, "", ...rows.map(line), "", dim(HINT), dim(LATER), ...(problem ? [NONE] : [])]
    stdout.write(`${drawn > 0 ? `\x1b[${drawn}F` : ""}\x1b[J${lines.join("\n")}\n`)
    drawn = lines.length
  }

  function move(step: 1 | -1): void {
    const index = movable.indexOf(at)
    at = movable[(index + step + movable.length) % movable.length] ?? at
  }

  return new Promise((resolve) => {
    function finish(result: AgentKindId[] | null): void {
      stdin.off("data", onData)
      process.off("SIGTERM", onTerm)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write(`\x1b[${drawn}F\x1b[J\x1b[?25h`)
      if (result !== null)
        stdout.write(`Providers: ${rows.flatMap((row) => (result.includes(row.id) ? [row.name] : [])).join(", ")}\n`)
      resolve(result)
    }
    function onTerm(): void {
      finish(null)
      process.exit(143)
    }
    function onData(data: Buffer): void {
      let text = data.toString("utf8")
      while (text.length > 0) {
        const up = UP.find((key) => text.startsWith(key))
        const down = DOWN.find((key) => text.startsWith(key))
        const key = up ?? down ?? text[0] ?? ""
        text = text.slice(key.length)
        if (key === "\x03") return finish(null)
        if (up) move(-1)
        else if (down) move(1)
        else if (key === " ") {
          const row = rows[at]
          if (row && row.blocked === null) {
            if (selected.has(row.id)) selected.delete(row.id)
            else selected.add(row.id)
          }
        } else if (key === "\r" || key === "\n") {
          // In the list's order, not the order they were checked.
          const picked = rows.flatMap((row) => (selected.has(row.id) ? [row.id] : []))
          if (picked.length > 0) return finish(picked)
          problem = true
          continue
        }
        problem = false
      }
      draw()
    }
    stdin.setRawMode(true)
    stdin.on("data", onData)
    stdin.resume()
    process.on("SIGTERM", onTerm)
    stdout.write("\x1b[?25l")
    draw()
  })
}
