import { RGBA } from "@opentui/core"
import { createSignal, Show } from "solid-js"
import type { ToolCall } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { useElapsedSeconds } from "./elapsed.ts"
import { cut, cutPath } from "./format.ts"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
const RESULT_INDENT = "  ⎿  "

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

export function resultSummary(tool: ToolCall): string {
  const lines = tool.result.split("\n").filter((line) => line.trim() !== "")
  if (tool.status === "error") {
    const exit = /^Exit code (\d+)$/.exec(lines[0] ?? "")
    if (!exit) return lines[0] ?? "failed"
    return [`exit ${exit[1]}`, lines[1]].filter(Boolean).join(" · ")
  }
  if (tool.createdFile) return "created"
  if (tool.patch) {
    const changed = tool.patch.flatMap((hunk) => hunk.lines)
    const added = changed.filter((line) => line.startsWith("+")).length
    const removed = changed.filter((line) => line.startsWith("-")).length
    return `+${added} −${removed}`
  }
  if (tool.name === "Read") return count(lines.filter((line) => /^\s*\d+\t/.test(line)).length, "line")
  if (tool.name === "Glob") return count(lines.length, "file")
  if (lines.length === 0) return "no output"
  return lines.length === 1 ? (lines[0] ?? "") : count(lines.length, "line")
}

function relative(target: string, cwd: string): string {
  return cwd && target.startsWith(`${cwd}/`) ? target.slice(cwd.length + 1) : target
}

export function ToolCallRow(props: { item: ToolCall; cwd: string; selected: boolean; expanded: boolean }) {
  const [width, setWidth] = createSignal(0)
  const running = () => props.item.status === "running"
  const seconds = useElapsedSeconds(running)
  const color = () => (props.item.status === "error" ? theme.error : running() ? theme.warning : theme.muted)
  const target = () => {
    const value = relative(props.item.summary, props.cwd)
    const room = width() - props.item.name.length - 4
    return value.includes(" ") ? cut(value, room) : cutPath(value, room)
  }
  const result = () => (running() ? `running… ${seconds()}s` : resultSummary(props.item))

  return (
    <box
      id={props.item.id}
      flexDirection="column"
      backgroundColor={(props.selected ? theme.selection : null) ?? CLEAR}
      onSizeChange={function () {
        setWidth(this.width)
      }}
    >
      <text wrapMode="none">
        <span style={{ fg: color() }}>●</span>
        <span style={{ fg: theme.text, bold: true }}>{` ${props.item.name}`}</span>
        <span style={{ fg: theme.text }}>{`(${target()})`}</span>
      </text>
      <text wrapMode="none">
        <span style={{ fg: theme.frame }}>{RESULT_INDENT}</span>
        <span style={{ fg: props.item.status === "done" ? theme.muted : color() }}>
          {cut(result(), width() - RESULT_INDENT.length)}
        </span>
      </text>
      <Show when={props.expanded && props.item.result}>
        <box paddingLeft={RESULT_INDENT.length}>
          <text fg={theme.text}>{props.item.result.trimEnd()}</text>
        </box>
      </Show>
    </box>
  )
}
