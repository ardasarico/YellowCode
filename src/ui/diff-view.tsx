import { RGBA } from "@opentui/core"
import { Index, Match, Show, Switch } from "solid-js"
import { theme } from "../theme/theme.ts"
import type { DiffRow } from "./diff.ts"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
export const HEAD_LIMIT = 20
const TAIL_LIMIT = 10
const SIGN = { add: "+", del: "-", ctx: " " } as const

function DiffLine(props: { row: DiffRow; digits: number }) {
  const line = () => (props.row.kind === "gap" ? null : props.row)
  return (
    <Switch>
      <Match when={line()}>
        {(row) => {
          const fg = () =>
            row().kind === "add" ? theme.diffAddText : row().kind === "del" ? theme.diffDelText : theme.muted
          const bg = () => (row().kind === "add" ? theme.diffAdd : row().kind === "del" ? theme.diffDel : null)
          return (
            <box flexDirection="row" backgroundColor={bg() ?? CLEAR}>
              <text fg={theme.frame} flexShrink={0}>{`${String(row().number).padStart(props.digits)} `}</text>
              <text fg={fg()} flexShrink={0}>{`${SIGN[row().kind]} `}</text>
              <text fg={fg()} flexGrow={1} wrapMode="char">
                {row().text.replaceAll("\t", "  ")}
              </text>
            </box>
          )
        }}
      </Match>
      <Match when={props.row.kind === "gap"}>
        <text fg={theme.frame}>{`${" ".repeat(props.digits + 1)}⋮`}</text>
      </Match>
    </Switch>
  )
}

// A new file shows its last lines; an edit shows its first ones.
export function DiffView(props: { rows: DiffRow[]; tail: boolean; expanded: boolean }) {
  const digits = () => String(Math.max(0, ...props.rows.map((row) => (row.kind === "gap" ? 0 : row.number)))).length
  const limit = () => (props.tail ? TAIL_LIMIT : HEAD_LIMIT)
  const hidden = () => (props.expanded ? 0 : Math.max(0, props.rows.length - limit()))
  const shown = () => {
    if (hidden() === 0) return props.rows
    return props.tail ? props.rows.slice(-limit()) : props.rows.slice(0, limit())
  }
  const note = (text: string) => `${" ".repeat(digits() + 1)}… ${text}`

  return (
    <box flexDirection="column" paddingLeft={2}>
      <Show when={props.tail && hidden() > 0}>
        <text fg={theme.muted}>{note(`${hidden()} lines above`)}</text>
      </Show>
      <Index each={shown()}>{(row) => <DiffLine row={row()} digits={digits()} />}</Index>
      <Show when={!props.tail && hidden() > 0}>
        <text fg={theme.muted}>{note(`${hidden()} more lines`)}</text>
      </Show>
    </box>
  )
}
