import { RGBA } from "@opentui/core"
import { Index, Match, Switch } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { AgentMark } from "../figures.tsx"
import { cut, formatDuration } from "../format.ts"
import { useDuration } from "./agent-line.tsx"
import type { TreeNode } from "./tree.ts"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
// The selection bar sits in the first column, so rows keep a two-column margin on each side.
const MARGIN = 2

export const agentColor = (index: number) => theme.agents[index % theme.agents.length] ?? theme.accent

type RowsProps = {
  selected: string | null
  width: number
  onPick: (id: string) => void
}

function Row(props: Omit<RowsProps, "selected"> & { node: TreeNode; selected: boolean }) {
  const duration = useDuration(() => props.node)
  const background = () => (props.selected ? theme.selection : null)
  const indent = () => " ".repeat(Math.max(0, props.node.depth - 1) * 2)
  const hasMark = () => props.node.kind !== "phase"
  const right = () => {
    if (props.node.kind === "phase") return props.node.detail
    if (props.node.kind === "queued") return ""
    return formatDuration(duration())
  }
  const rightColor = () => (props.node.state === "running" && props.node.kind !== "phase" ? theme.accent : theme.muted)
  const room = () =>
    props.width - MARGIN * 2 - indent().length - (hasMark() ? 2 : 0) - (right() ? Bun.stringWidth(right()) + 1 : 0)
  const nameColor = () => (props.node.kind === "queued" ? theme.faint : theme.text)
  return (
    <box
      flexDirection="row"
      height={1}
      width={props.width}
      backgroundColor={background() ?? CLEAR}
      onMouseDown={(event) => {
        if (!props.node.selectable) return
        event.preventDefault()
        props.onPick(props.node.id)
      }}
    >
      <text wrapMode="none" flexShrink={0}>
        <span style={{ fg: theme.accent }}>{props.selected ? "▎" : " "}</span>
        <span>{` ${indent()}`}</span>
      </text>
      <Switch>
        <Match when={props.node.kind === "queued"}>
          <text fg={theme.faint} flexShrink={0}>
            {"○ "}
          </text>
        </Match>
        <Match when={hasMark()}>
          <AgentMark
            color={agentColor(props.node.colorIndex)}
            state={props.node.state === "queued" ? "running" : props.node.state}
            size="small"
            background={background() ?? theme.band ?? theme.background}
          />
          <text flexShrink={0}> </text>
        </Match>
      </Switch>
      <text wrapMode="none" flexGrow={1} flexShrink={1}>
        <span style={{ fg: nameColor(), bold: props.selected || props.node.kind === "phase" }}>
          {cut(props.node.name, Math.max(1, room()))}
        </span>
      </text>
      <text wrapMode="none" flexShrink={0} fg={rightColor()}>
        {right() ? ` ${right()}` : ""}
      </text>
      <text flexShrink={0}>{" ".repeat(MARGIN)}</text>
    </box>
  )
}

export function TreeRows(props: RowsProps & { nodes: TreeNode[] }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <Index each={props.nodes}>
        {(node) => (
          <Row node={node()} selected={props.selected === node().id} width={props.width} onPick={props.onPick} />
        )}
      </Index>
    </box>
  )
}
