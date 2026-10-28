import { RGBA } from "@opentui/core"
import { createMemo, createSignal, Index, Show } from "solid-js"
import type { Session, ToolCall } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { AgentLine, WorkflowLine } from "./agents/agent-line.tsx"
import { NodeRow } from "./agents/agent-panel.tsx"
import { agentNode, innerNodes, isWorkflowCall, type TreeNode } from "./agents/tree.ts"
import { agentColor } from "./agents/tree-rows.tsx"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
const MAX_INNER = 3
// Puts an inner row's mark under the parent's name.
const INDENT = 2

// Up to `max` nodes in tree order; running nodes are first in line for a place.
function shownInner(nodes: TreeNode[], max: number): TreeNode[] {
  if (nodes.length <= max) return nodes
  const order = [...new Set([...nodes.filter((node) => node.state === "running"), ...nodes])]
  const kept = new Set(order.slice(0, max))
  return nodes.filter((node) => kept.has(node))
}

export function AgentRow(props: {
  item: ToolCall
  index: number
  session: Session
  selected: boolean
  docked: boolean
  onOpen: (id: string) => void
}) {
  const [width, setWidth] = createSignal(0)
  const [hovered, setHovered] = createSignal(false)
  const background = () => (props.selected ? theme.selection : hovered() ? theme.band : null)
  const inner = createMemo(() => (isWorkflowCall(props.item) ? [] : innerNodes(props.session, props.item, props.index)))
  const running = () => agentNode(props.session, props.item, 0, null, 0).state === "running"
  const shown = () => (running() ? shownInner(inner(), MAX_INNER) : [])
  const hidden = () => (running() ? inner().length - shown().length : 0)
  const line = () => ({
    session: props.session,
    tool: props.item,
    color: agentColor(props.index),
    width: width(),
    background: background(),
    docked: props.docked,
  })

  return (
    <box
      flexDirection="column"
      onSizeChange={function () {
        setWidth(this.width)
      }}
    >
      <box
        id={props.item.id}
        backgroundColor={background() ?? CLEAR}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseDown={(event) => {
          event.preventDefault()
          props.onOpen(props.item.id)
        }}
      >
        <Show when={isWorkflowCall(props.item)} fallback={<AgentLine {...line()} inner={inner()} />}>
          <WorkflowLine {...line()} />
        </Show>
      </box>
      <Index each={shown()}>
        {(node) => {
          const indent = () => INDENT + (node().depth - 2) * 2
          return (
            <box flexDirection="row" height={1}>
              <text flexShrink={0}>{" ".repeat(indent())}</text>
              <NodeRow node={node()} selected={false} width={width() - indent()} onOpen={props.onOpen} />
            </box>
          )
        }}
      </Index>
      <Show when={hidden() > 0}>
        <text fg={theme.muted} wrapMode="none">{`${" ".repeat(INDENT + 1)}+${hidden()} more`}</text>
      </Show>
    </box>
  )
}
