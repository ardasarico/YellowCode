import { For } from "solid-js"
import { type ModApi, type ModToolCall, theme } from "yellowcode/mod"

const SHOWN = 3
const SHOWN_EXPANDED = 20

// terminal_read starts "Screen of terminal 1 (zsh):", then the screen, then a blank line before the log.
function screenOf(result: string): { tab: string; shell: string; lines: string[] } | null {
  const [head = "", ...rest] = result.split("\n")
  const match = /^Screen of terminal (\d+) \((.*)\):$/.exec(head)
  if (!match) return null
  const end = rest.indexOf("Output so far, escape codes removed:")
  const screen = (end < 0 ? rest : rest.slice(0, end)).join("\n").trimEnd().split("\n")
  return { tab: match[1] ?? "", shell: match[2] ?? "", lines: screen }
}

function cut(text: string, room: number): string {
  const kept = Array.from(text)
  while (kept.length > 0 && Bun.stringWidth(kept.join("")) > room) kept.pop()
  return kept.join("")
}

function Lines(props: { lines: string[]; width: number }) {
  return (
    <For each={props.lines}>
      {(line) => (
        <text wrapMode="none">
          <span style={{ fg: theme.frame }}>{"  │ "}</span>
          <span style={{ fg: theme.muted }}>{cut(line, Math.max(0, props.width - 4))}</span>
        </text>
      )}
    </For>
  )
}

function readRow(tool: ModToolCall) {
  const screen = tool.status === "done" ? screenOf(tool.result) : null
  if (!screen) return { title: "Terminal", text: "read" }
  return {
    title: "Terminal",
    text: `read tab ${screen.tab} · ${screen.shell}`,
    body: (props: { width: number; expanded: boolean }) => (
      <Lines lines={screen.lines.slice(-(props.expanded ? SHOWN_EXPANDED : SHOWN))} width={props.width} />
    ),
  }
}

function listRow(tool: ModToolCall) {
  if (tool.status !== "done") return { title: "Terminal", text: "list" }
  const lines = tool.result.startsWith("No terminals") ? [] : tool.result.split("\n").filter(Boolean)
  return {
    title: "Terminal",
    text: `list · ${lines.length === 0 ? "none" : lines.length} open`,
    body: (props: { width: number }) => <Lines lines={lines} width={props.width} />,
  }
}

// The rows of this mod's own tools, which otherwise read "mod-terminal/terminal_read" with raw output.
export function addRows(mod: ModApi): void {
  mod.toolRows.add({
    render(tool) {
      if (tool.source !== `mod-${mod.id}`) return null
      if (tool.short === "terminal_read") return readRow(tool)
      if (tool.short === "terminal_list") return listRow(tool)
      return null
    },
  })
}
