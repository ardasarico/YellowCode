import { RGBA } from "@opentui/core"
import { createSignal, Index, Show } from "solid-js"
import type { Session } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { AgentMark } from "../figures.tsx"
import { cut, formatDuration } from "../format.ts"
import { failure, useDuration, WorkflowFields, workflowMark, useWorkflowRow } from "./agent-line.tsx"
import { activeNodes, type TreeNode } from "./tree.ts"
import { agentColor } from "./tree-rows.tsx"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
const MAX_ROWS = 5
const KEYS = [
  { key: "↑↓", word: "select" },
  { key: "enter", word: "open" },
  { key: "esc", word: "back" },
]

// Top-level agents and workflows that are running or started since the latest user message: running first, then
// newest first.
export function panelNodes(session: Session): TreeNode[] {
  const nodes = activeNodes(session).toReversed()
  return [...nodes.filter((node) => node.state === "running"), ...nodes.filter((node) => node.state !== "running")]
}

// The first rows; a selected node that sorts past them takes the last one, so the selection stays on it.
export function shownNodes(nodes: TreeNode[], selected: string | null): TreeNode[] {
  const shown = nodes.slice(0, MAX_ROWS)
  const kept = shown.some((node) => node.id === selected) ? undefined : nodes.find((node) => node.id === selected)
  return kept ? [...shown.slice(0, -1), kept] : shown
}

function status(node: TreeNode, room: number): { text: string; color: RGBA } {
  if (node.state === "failed") return { text: failure(node, room), color: theme.error }
  if (node.state === "stopped") return { text: "stopped", color: theme.warning }
  if (node.state !== "running") return { text: "done", color: theme.muted }
  return { text: node.detail || "running", color: theme.text }
}

function Row(props: { node: TreeNode; selected: boolean; width: number; onOpen: (id: string) => void }) {
  const duration = useDuration(() => props.node)
  const [hovered, setHovered] = createSignal(false)
  const background = () => (props.selected ? theme.selection : hovered() ? theme.band : null)
  const time = () => ` · ${formatDuration(duration())}`
  // The selection bar, the mark and the gap after it.
  const room = () => props.width - 3
  const name = () => cut(props.node.name, Math.max(1, room() - Bun.stringWidth(time())))
  const detailRoom = () => room() - Bun.stringWidth(name()) - Bun.stringWidth(time()) - 3
  const detail = () => {
    const { text, color } = status(props.node, detailRoom())
    return { text: detailRoom() >= 4 ? cut(text, detailRoom()) : "", color }
  }
  const workflow = () => props.node.kind === "workflow"
  const row = useWorkflowRow(() => props.node, duration, room)
  const shownName = () => (workflow() ? row.name() : name())
  const mark = () => (workflow() ? workflowMark(props.node, agentColor(props.node.colorIndex)) : null)
  return (
    <box
      flexDirection="row"
      height={1}
      width={props.width}
      backgroundColor={background() ?? CLEAR}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        event.preventDefault()
        props.onOpen(props.node.id)
      }}
    >
      <text fg={theme.accent} flexShrink={0}>
        {props.selected ? "▎" : " "}
      </text>
      <AgentMark
        color={mark()?.color ?? agentColor(props.node.colorIndex)}
        state={mark()?.state ?? (props.node.state === "queued" ? "running" : props.node.state)}
        size="small"
        background={background() ?? theme.background}
      />
      <text wrapMode="none">
        {/* A span never drops bold once set, so the selected name is its own span. */}
        <Show when={props.selected} fallback={<span style={{ fg: theme.text }}>{` ${shownName()}`}</span>}>
          <span style={{ fg: theme.text, bold: true }}>{` ${shownName()}`}</span>
        </Show>
        <Show
          when={workflow()}
          fallback={
            <>
              <span style={{ fg: theme.faint }}>{detail().text ? " · " : ""}</span>
              <span style={{ fg: detail().color }}>{detail().text}</span>
              <span style={{ fg: theme.faint }}>{" · "}</span>
              <span style={{ fg: props.node.state === "running" ? theme.accent : theme.muted }}>
                {formatDuration(duration())}
              </span>
            </>
          }
        >
          <WorkflowFields node={props.node} size={row.size()} parts={row.parts()} />
        </Show>
      </text>
    </box>
  )
}

// One row per node below the info line, a `+N more` row when cut, and the key line while it has the keys.
export function AgentPanel(props: {
  nodes: TreeNode[]
  selected: string | null
  width: number
  onOpen: (id: string) => void
}) {
  const hidden = () => props.nodes.length - shownNodes(props.nodes, props.selected).length
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <Index each={shownNodes(props.nodes, props.selected)}>
        {(node) => (
          <Row node={node()} selected={props.selected === node().id} width={props.width} onOpen={props.onOpen} />
        )}
      </Index>
      <Show when={hidden() > 0}>
        <text fg={theme.muted} wrapMode="none">{` +${hidden()} more`}</text>
      </Show>
      <Show when={props.selected !== null}>
        <text wrapMode="none" marginTop={1}>
          <span> </span>
          <Index each={KEYS}>
            {(entry, index) => (
              <>
                <span style={{ fg: theme.faint }}>{index === 0 ? "" : " · "}</span>
                <span style={{ fg: theme.text }}>{entry().key}</span>
                <span style={{ fg: theme.muted }}>{` ${entry().word}`}</span>
              </>
            )}
          </Index>
        </text>
      </Show>
    </box>
  )
}
