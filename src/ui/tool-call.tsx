import { RGBA } from "@opentui/core"
import { createSignal, Index, Show } from "solid-js"
import { askUserQuestionInput, OWN_ASK } from "../protocol/messages.ts"
import { QUESTION_DECLINED, TOOL_DECLINED } from "../protocol/outgoing.ts"
import { ownAskProblem, severe } from "../session/ask.ts"
import type { Ask, Task, ToolCall } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { writtenContent } from "../session/tool-summary.ts"
import { useDuration } from "./agents/agent-line.tsx"
import { addedRows, diffRows } from "./diff.ts"
import { DiffView } from "./diff-view.tsx"
import { useElapsedSeconds } from "./elapsed.ts"
import { cut, cutPath, formatDuration, mcpTool } from "./format.ts"
import { ImageLabels } from "./image-label.tsx"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
const RESULT_INDENT = "  ⎿  "
const LINE_INDENT = " ".repeat(RESULT_INDENT.length)
const DEFAULT_DENIALS = new Set([TOOL_DECLINED, QUESTION_DECLINED])
// Matches `"<question>"="<answer>"` with optional ` notes: <note>` in an AskUserQuestion tool result. Our own ask
// answers a matrix the same way, row by row.
const ANSWER_IN_RESULT = /"([^"]*)"="([^"]*)"(?: notes: ([\s\S]*?))?(?=, "|\. |\.?$)/g

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

export function resultSummary(tool: ToolCall): string {
  if (tool.status === "stopped") return "stopped"
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

export function isBackgroundShell(tool: ToolCall): boolean {
  const input = tool.input
  const background = typeof input === "object" && input !== null && "run_in_background" in input
  return tool.name === "Bash" && tool.taskId !== null && background && input.run_in_background === true
}

// The result of a background Bash only says it was launched, so the line follows the shell's task instead.
export function toolLines(
  tool: ToolCall,
  ask: Ask | null,
  shell: Pick<Task, "state"> | null,
  elapsedMs: number,
): string[] {
  const question = tool.name === "AskUserQuestion" || tool.name === OWN_ASK
  if (ask?.status === "pending") return [question ? "waiting for your answer" : "waiting for your approval"]
  if (ask?.status === "denied") return [deniedLine(ask)]
  if (isBackgroundShell(tool)) {
    if (!shell) return ["in background"]
    return [shell.state === "running" ? `running in background · ${formatDuration(elapsedMs)}` : "ran in background"]
  }
  if (tool.status === "running") return [`running… ${Math.floor(elapsedMs / 1000)}s`]
  const answers = question ? answerLines(tool, ask) : []
  return answers.length > 0 ? answers : [resultSummary(tool)]
}

function shellColor(shell: Task | null) {
  if (shell?.state === "running") return theme.accent
  if (shell?.state === "failed") return theme.error
  if (shell?.state === "stopped") return theme.warning
  return theme.muted
}

export function deniedLine(ask: Ask): string {
  const problem = ownAskProblem(ask)
  if (problem) return `rejected · ${problem}`
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

// MCP inputs have no known field to summarize, so a single value is shown alone and several as `key: value` pairs.
function mcpArguments(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  const pairs = Object.entries(input).flatMap(([key, value]) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [[key, String(value).split("\n")[0] ?? ""]]
      : [],
  )
  if (pairs.length === 1) return pairs[0]?.[1] ?? ""
  return pairs.map(([key, value]) => `${key}: ${value}`).join(", ")
}

export function relative(target: string, cwd: string): string {
  return cwd && target.startsWith(`${cwd}/`) ? target.slice(cwd.length + 1) : target
}

export function ToolCallRow(props: {
  item: ToolCall
  ask?: Ask | null
  task?: Task | null
  cwd: string
  selected: boolean
  expanded: boolean
  selection?: string | null
  onOpenShell?: (taskId: string) => void
  onOpenImage?: (id: string) => void
}) {
  const [width, setWidth] = createSignal(0)
  const waiting = () => props.ask?.status === "pending"
  const denied = () => props.ask?.status === "denied"
  const running = () => props.item.status === "running" && !waiting()
  const seconds = useElapsedSeconds(running)
  const background = () => isBackgroundShell(props.item)
  const shell = () => (background() ? (props.task ?? null) : null)
  const shellMs = useDuration(() => ({
    state: shell()?.state ?? "completed",
    durationMs: 0,
    startedAt: shell()?.startedAt ?? null,
  }))
  const color = () => {
    if (background() && !waiting() && !denied()) return shellColor(shell())
    if (props.ask && waiting()) return severe(props.ask) ? theme.error : theme.warning
    if (denied() || props.item.status === "error") return theme.error
    if (props.item.status === "stopped") return theme.warning
    return props.item.status === "running" ? theme.accent : theme.muted
  }
  // Our own ask stands in for the stock one, so it reads like it.
  const label = () => {
    if (props.item.name === OWN_ASK) return { server: "", tool: "AskUserQuestion" }
    const mcp = mcpTool(props.item.name)
    return mcp ? { server: `${mcp.server}/`, tool: mcp.tool } : { server: "", tool: props.item.name }
  }
  const target = () => {
    const summary = props.item.summary || (label().server ? mcpArguments(props.item.input) : "")
    const value = relative(summary, props.cwd)
    const room = width() - Bun.stringWidth(label().server + label().tool) - 4
    return value.includes(" ") ? cut(value, room) : cutPath(value, room)
  }
  // An image result has no text, so its labels stand in for the summary line.
  const imageOnly = () => props.item.images.length > 0 && props.item.status === "done" && !props.item.result.trim()
  const lines = () =>
    imageOnly() ? [] : toolLines(props.item, props.ask ?? null, shell(), background() ? shellMs() : seconds() * 1000)
  const lineColor = () => (props.item.status === "done" && !denied() && !background() ? theme.muted : color())
  // The user's answer outranks a replayed result, which may come from a different answer.
  const output = () => (denied() || background() || props.ask?.status === "answered" ? "" : props.item.result)
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
      onMouseDown={(event) => {
        const taskId = props.item.taskId
        if (!background() || !taskId || !props.onOpenShell) return
        event.preventDefault()
        props.onOpenShell(taskId)
      }}
    >
      <text wrapMode="none">
        <span style={{ fg: color() }}>●</span>
        <span style={{ fg: theme.muted }}>{` ${label().server}`}</span>
        <span style={{ fg: theme.text, bold: true }}>{label().tool}</span>
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
      <ImageLabels
        itemId={props.item.id}
        images={props.item.images}
        prefix={(index) => (index === 0 && lines().length === 0 ? RESULT_INDENT : LINE_INDENT)}
        selection={props.selection}
        onOpen={props.onOpenImage}
      />
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
