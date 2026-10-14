import { RGBA } from "@opentui/core"
import { createSignal, Show } from "solid-js"
import type { Session, ToolCall } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { AgentLine, WorkflowLine } from "./agents/agent-line.tsx"
import { isWorkflowCall } from "./agents/tree.ts"
import { agentColor } from "./agents/tree-rows.tsx"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)

export function AgentRow(props: {
  item: ToolCall
  index: number
  session: Session
  selected: boolean
  onOpen: (id: string) => void
}) {
  const [width, setWidth] = createSignal(0)
  const [hovered, setHovered] = createSignal(false)
  const background = () => (props.selected ? theme.selection : hovered() ? theme.band : null)
  const line = () => ({
    session: props.session,
    tool: props.item,
    color: agentColor(props.index),
    width: width(),
    background: background(),
  })

  return (
    <box
      id={props.item.id}
      backgroundColor={background() ?? CLEAR}
      onSizeChange={function () {
        setWidth(this.width)
      }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        event.preventDefault()
        props.onOpen(props.item.id)
      }}
    >
      <Show when={isWorkflowCall(props.item)} fallback={<AgentLine {...line()} />}>
        <WorkflowLine {...line()} />
      </Show>
    </box>
  )
}
