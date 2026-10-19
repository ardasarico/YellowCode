import type { RGBA } from "@opentui/core"
import { createMemo, Index, Show } from "solid-js"
import type { Session, TaskState, ToolCall } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { AgentMark } from "../figures.tsx"
import { cut, formatDuration } from "../format.ts"
import { useTicker } from "../ticker.ts"
import { agentNode, barCells, barSize, type TreeNode, workflowNode } from "./tree.ts"

const MARK_WIDTH = 3
const MORE = " ›"

export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

type Timed = Pick<TreeNode, "state" | "durationMs" | "startedAt">

// A running node's duration counts up from its start, since progress reports arrive only now and then.
function elapsed({ state, durationMs, startedAt }: Timed): number {
  if (state !== "running" || startedAt === null) return durationMs
  return Math.max(durationMs, Date.now() - startedAt)
}

export function useDuration(node: () => Timed): () => number {
  const tick = useTicker(() => node().state === "running" && node().startedAt !== null, 1000)
  return () => {
    tick()
    return elapsed(node())
  }
}

function stateColor(state: TreeNode["state"]): RGBA {
  if (state === "failed") return theme.error
  if (state === "stopped") return theme.warning
  return state === "running" ? theme.accent : theme.muted
}

function Line(props: {
  node: TreeNode
  color: RGBA
  width: number
  background?: RGBA | null
  detail: string
  stats: string
}) {
  const room = () => Math.max(0, props.width - MARK_WIDTH)
  const tail = () => `${props.stats ? ` · ${props.stats}` : ""}${MORE}`
  const name = () => cut(props.node.name, Math.max(1, room() - Bun.stringWidth(tail())))
  const detailRoom = () => room() - Bun.stringWidth(name()) - Bun.stringWidth(tail()) - 3
  const detail = () => (props.detail && detailRoom() >= 4 ? ` · ${cut(props.detail, detailRoom())}` : "")
  return (
    <box flexDirection="row" height={1}>
      <AgentMark
        color={props.color}
        state={props.node.state === "queued" ? "running" : props.node.state}
        size={props.node.state === "running" ? undefined : "medium"}
        background={props.background}
      />
      <text wrapMode="none">
        <span style={{ fg: theme.text, bold: true }}>{` ${name()}`}</span>
        <span style={{ fg: theme.text }}>{detail()}</span>
        <Show when={props.stats}>
          <span style={{ fg: stateColor(props.node.state) }}>{` · ${props.stats}`}</span>
        </Show>
        <span style={{ fg: theme.faint }}>{MORE}</span>
      </text>
    </box>
  )
}

// `API 500` for an API error, else the error's first sentence without claude's "Agent terminated early" opening.
export function shortError(error: string): string {
  const status = /API Error: (\d{3})/.exec(error)?.[1]
  if (status) return `API ${status}`
  const text = error.replace(/^Agent terminated early due to [^:]*:\s*/, "").trim()
  return text.split(/(?<=[.!?])\s/)[0] ?? text
}

// `failed: <short error>` cut to `room` columns, or the bare state when there is no error or no room for it.
export function failure(node: TreeNode, room: number): string {
  const reasonRoom = room - "failed: ".length
  if (node.state !== "failed" || !node.error || reasonRoom < 4) return node.state
  return `failed: ${cut(shortError(node.error), reasonRoom)}`
}

function outcome(node: TreeNode, rest: string, room: number): string {
  if (node.state === "failed" || node.state === "stopped")
    return `${failure(node, room - Bun.stringWidth(rest) - 3)} · ${rest}`
  return rest
}

export function AgentLine(props: {
  session: Session
  tool: ToolCall
  color: RGBA
  width: number
  background?: RGBA | null
}) {
  const node = createMemo(() => agentNode(props.session, props.tool, 0, null, 0))
  const duration = useDuration(node)
  const detail = () => (node().state === "running" ? node().detail : "")
  // The mark, the space and ` · ` before the stats, and the more sign after them.
  const room = () => props.width - MARK_WIDTH - 1 - Bun.stringWidth(node().name) - 3 - MORE.length
  const stats = () => outcome(node(), `${count(node().toolUses, "tool")} · ${formatDuration(duration())}`, room())
  return (
    <Line
      node={node()}
      color={props.color}
      width={props.width}
      background={props.background}
      detail={detail()}
      stats={stats()}
    />
  )
}

type Part = { text: string; color: RGBA }

function tokenCount(n: number): string {
  if (n < 1000) return `${n} tok`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`
  return `${(n / 1_000_000).toFixed(1)}M tok`
}

function workflowParts(node: TreeNode, duration: number): Part[] {
  const bar = node.progress
  const running = node.state === "running"
  const parts: Part[] = []
  if (bar && bar.total > 0) parts.push({ text: `${bar.done}/${bar.total}`, color: running ? theme.text : theme.muted })
  else if (running) parts.push({ text: "starting…", color: theme.muted })
  if (bar && bar.failed > 0) parts.push({ text: `${bar.failed} failed`, color: theme.error })
  else if (node.state === "failed" || node.state === "stopped")
    parts.push({ text: node.state, color: stateColor(node.state) })
  parts.push({ text: formatDuration(duration), color: running ? theme.accent : theme.muted })
  if (bar && bar.tokens > 0) parts.push({ text: tokenCount(bar.tokens), color: theme.muted })
  return parts
}

// A workflow's mark turns red once any of its agents failed, and a finished one shows a cross.
export function workflowMark(node: TreeNode, color: RGBA): { color: RGBA; state: TaskState } {
  const failed = (node.progress?.failed ?? 0) > 0
  const state = failed && node.state === "completed" ? "failed" : node.state
  return { color: failed ? theme.error : color, state: state === "queued" ? "running" : state }
}

// `room` is the width left after the mark and the space before the name; `tail` is any text drawn after the stats.
export function useWorkflowRow(node: () => TreeNode, duration: () => number, room: () => number, tail = 0) {
  const parts = createMemo(() => workflowParts(node(), duration()))
  const stats = () =>
    Bun.stringWidth(
      parts()
        .map((part) => part.text)
        .join(" · "),
    ) + tail
  const size = () => barSize(room() - Bun.stringWidth(node().name) - stats())
  const name = () => cut(node().name, Math.max(1, room() - stats() - (size() > 0 ? size() + 4 : 2)))
  return { name, size, parts }
}

export function WorkflowFields(props: { node: TreeNode; size: number; parts: Part[] }) {
  const cells = () => barCells(props.node.progress ?? { done: 0, failed: 0, total: 0, tokens: 0 }, props.size)
  return (
    <>
      <span>{"  "}</span>
      <Show when={props.size > 0}>
        <span style={{ fg: props.node.state === "running" ? theme.text : theme.muted }}>
          {"█".repeat(cells().done)}
        </span>
        <span style={{ fg: theme.error }}>{"█".repeat(cells().failed)}</span>
        <span style={{ fg: theme.faint }}>{"░".repeat(cells().empty)}</span>
        <span>{"  "}</span>
      </Show>
      <Index each={props.parts}>
        {(part, index) => (
          <>
            <span style={{ fg: theme.faint }}>{index === 0 ? "" : " · "}</span>
            <span style={{ fg: part().color }}>{part().text}</span>
          </>
        )}
      </Index>
    </>
  )
}

export function WorkflowLine(props: {
  session: Session
  tool: ToolCall
  color: RGBA
  width: number
  background?: RGBA | null
}) {
  const node = createMemo(() => workflowNode(props.session, props.tool, 0, null, 0))
  const duration = useDuration(node)
  const row = useWorkflowRow(node, duration, () => Math.max(0, props.width - MARK_WIDTH), MORE.length)
  const mark = () => workflowMark(node(), props.color)
  return (
    <box flexDirection="row" height={1}>
      <AgentMark
        color={mark().color}
        state={mark().state}
        size={node().state === "running" ? undefined : "medium"}
        background={props.background}
      />
      <text wrapMode="none">
        <span style={{ fg: theme.text, bold: true }}>{` ${row.name()}`}</span>
        <WorkflowFields node={node()} size={row.size()} parts={row.parts()} />
        <span style={{ fg: theme.faint }}>{MORE}</span>
      </text>
    </box>
  )
}
