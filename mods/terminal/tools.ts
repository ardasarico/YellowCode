import type { ModApi } from "yellowcode/mod"
import { plainLine, type Terminals } from "./terminals.ts"

const DEFAULT_LINES = 80
const MAX_LINES = 400

const number = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback

// Read-only: Claude can see the terminals but never type into them.
export function addTools(mod: ModApi, terminals: Terminals): void {
  mod.tools.add({
    name: "terminal_list",
    description: "List the user's open terminals in YellowCode's terminal pane: their tab number, shell and folder.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, title: "List terminals" },
    run() {
      const list = terminals.list()
      if (list.length === 0) return "No terminals are open."
      const active = terminals.active()
      return list
        .map(
          (terminal, index) =>
            `${index + 1}. ${terminal.title} in ${terminal.cwd}${terminal === active ? " (active)" : ""}`,
        )
        .join("\n")
    },
  })

  mod.tools.add({
    name: "terminal_read",
    description:
      "Read what the user sees in one of their terminals: the current screen, and with more lines the output before it. Defaults to the active terminal.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "integer", minimum: 1, description: "Tab number from terminal_list; the active one if left out." },
        lines: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LINES,
          description: `Lines of output, ${DEFAULT_LINES} by default.`,
        },
      },
    },
    annotations: { readOnlyHint: true, title: "Read a terminal" },
    run(input) {
      const list = terminals.list()
      const tab = number(input.tab, 0)
      const terminal = tab > 0 ? list[tab - 1] : terminals.active()
      if (!terminal) return { text: tab > 0 ? `There is no terminal ${tab}.` : "No terminals are open.", isError: true }
      const lines = Math.min(MAX_LINES, number(input.lines, DEFAULT_LINES))
      const screen = terminal.view?.screen().lines.join("\n").trimEnd() ?? ""
      // The last line has no newline yet while the shell waits at its prompt.
      const earlier = [...terminal.log, plainLine(terminal.partial)].slice(-lines).join("\n").trimEnd()
      return [
        `Screen of terminal ${list.indexOf(terminal) + 1} (${terminal.title}):`,
        screen,
        "",
        "Output so far, escape codes removed:",
        earlier,
      ].join("\n")
    },
  })
}
