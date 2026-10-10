import { RGBA } from "@opentui/core"
import { createSignal, Index, Show } from "solid-js"
import { askUserQuestionInput } from "../protocol/messages.ts"
import { QUESTION_DECLINED, TOOL_DECLINED } from "../protocol/outgoing.ts"
import { severe } from "../session/ask.ts"
import type { Ask, ToolCall } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { writtenContent } from "../session/tool-summary.ts"
import { addedRows, diffRows } from "./diff.ts"
import { DiffView } from "./diff-view.tsx"
import { useElapsedSeconds } from "./elapsed.ts"
import { cut, cutPath } from "./format.ts"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
const RESULT_INDENT = "  ⎿  "
const LINE_INDENT = " ".repeat(RESULT_INDENT.length)
const DEFAULT_DENIALS = new Set([TOOL_DECLINED, QUESTION_DECLINED])
// Matches `"<question>"="<answer>"` with optional ` notes: <note>` in an AskUserQuestion tool result.
const ANSWER_IN_RESULT = /"([^"]*)"="([^"]*)"(?: notes: ([\s\S]*?))?(?=, "|\. |\.?$)/g

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
  if (tool.createdFile) {
    const content = writtenContent(tool.input)
    return content === null ? "created" : `created · ${count(addedRows(content).length, "line")}`
  }
  if (tool.patch) {
    const changed = tool.patch.flatMap((hunk) => hunk.lines)
    const added = changed.filter((line) => line.startsWith("+")).length
    const removed = changed.filter((line) => line.startsWith("-")).length
    return `+${added} −${removed}`
  }
  if (tool.unchanged) return "unchanged"
  if (tool.name === "Read") return count(lines.filter((line) => /^\s*\d+\t/.test(line)).length, "line")
  if (tool.name === "Glob") return count(lines.length, "file")
  if (lines.length === 0) return "no output"
  return lines.length === 1 ? (lines[0] ?? "") : count(lines.length, "line")
}

export function deniedLine(ask: Ask): string {
  const note = ask.denial.trim().replaceAll("\n", " ")
  return note && !DEFAULT_DENIALS.has(note) ? `denied · ${note}` : "denied"
}

export function answerLines(tool: ToolCall, ask: Ask | null): string[] {
  let answers = ask?.answers ?? {}
  let notes = ask?.notes ?? {}
  if (ask?.status !== "answered") {
    const found = [...tool.result.matchAll(ANSWER_IN_RESULT)]
    answers = Object.fromEntries(found.map(([, question = "", answer = ""]) => [question, answer]))
    notes = Object.fromEntries(found.map(([, question = "", , note = ""]) => [question, note]))
  }
  const questions = askUserQuestionInput.safeParse(tool.input).data?.questions ?? []
  return Object.entries(answers).map(([question, answer]) => {
    const header = questions.find((entry) => entry.question === question)?.header ?? question
    const note = notes[question]?.replaceAll("\n", " ")
    return note ? `${header}: ${answer} · ${note}` : `${header}: ${answer}`
  })
}

export function relative(target: string, cwd: string): string {
  return cwd && target.startsWith(`${cwd}/`) ? target.slice(cwd.length + 1) : target
}

export function ToolCallRow(props: {
  item: ToolCall
  ask?: Ask | null
  cwd: string
  selected: boolean
  expanded: boolean
}) {
  const [width, setWidth] = createSignal(0)
  const waiting = () => props.ask?.status === "pending"
  const denied = () => props.ask?.status === "denied"
  const running = () => props.item.status === "running" && !waiting()
  const seconds = useElapsedSeconds(running)
  const color = () => {
    if (props.ask && waiting()) return severe(props.ask) ? theme.error : theme.warning
    if (denied() || props.item.status === "error") return theme.error
    return props.item.status === "running" ? theme.accent : theme.muted
  }
  const target = () => {
    const value = relative(props.item.summary, props.cwd)
    const room = width() - props.item.name.length - 4
    return value.includes(" ") ? cut(value, room) : cutPath(value, room)
  }
  const lines = () => {
    if (waiting()) return ["waiting for your approval"]
    if (props.ask && denied()) return [deniedLine(props.ask)]
    if (running()) return [`running… ${seconds()}s`]
    const answers = props.item.name === "AskUserQuestion" ? answerLines(props.item, props.ask ?? null) : []
    return answers.length > 0 ? answers : [resultSummary(props.item)]
  }
  const lineColor = () => (props.item.status === "done" && !denied() ? theme.muted : color())
  // The user's answer outranks a replayed result, which may come from a different answer.
  const output = () => (denied() || props.ask?.status === "answered" ? "" : props.item.result)
  const diff = () => {
    const tool = props.item
    if (tool.status !== "done" || denied()) return null
    if (tool.createdFile) {
      const content = writtenContent(tool.input)
      return content === null ? null : { rows: addedRows(content), tail: true }
    }
    return tool.patch && tool.patch.length > 0 ? { rows: diffRows(tool.patch), tail: false } : null
  }

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
      <Index each={lines()}>
        {(line, index) => (
          <text wrapMode="none">
            <span style={{ fg: theme.frame }}>{index === 0 ? RESULT_INDENT : LINE_INDENT}</span>
            <span style={{ fg: lineColor() }}>{cut(line(), width() - RESULT_INDENT.length)}</span>
          </text>
        )}
      </Index>
      <Show
        when={diff()}
        fallback={
          <Show when={props.expanded && output()}>
            <box paddingLeft={RESULT_INDENT.length}>
              <text fg={theme.text}>{output().trimEnd()}</text>
            </box>
          </Show>
        }
      >
        {(shown) => <DiffView rows={shown().rows} tail={shown().tail} expanded={props.expanded} />}
      </Show>
    </box>
  )
}
