import { type LineColorConfig, type LineNumberRenderable, type LineSign, RGBA } from "@opentui/core"
import { createEffect, Index, Match, Show, Switch } from "solid-js"
import { syntaxStyle, theme } from "../theme/theme.ts"
import type { DiffRow } from "./diff.ts"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
export const HEAD_LIMIT = 20
const TAIL_LIMIT = 10
// Each row is a few renderables, and OpenTUI stops drawing past a fixed number of them.
const EXPANDED_LIMIT = 2000
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

// One highlighted block keeps the colors right across lines; the gutter adds numbers, signs and row tints.
function SyntaxRows(props: { rows: DiffRow[]; filetype: string }) {
  let gutter: LineNumberRenderable | undefined
  const content = () => props.rows.map((row) => (row.kind === "gap" ? "" : row.text.replaceAll("\t", "  "))).join("\n")
  createEffect(() => {
    const colors = new Map<number, LineColorConfig>()
    const signs = new Map<number, LineSign>()
    const numbers = new Map<number, number>()
    const hidden = new Set<number>()
    props.rows.forEach((row, index) => {
      if (row.kind === "gap") {
        hidden.add(index)
        signs.set(index, { after: " ⋮", afterColor: theme.frame })
        return
      }
      numbers.set(index, row.number)
      if (row.kind === "ctx") return
      signs.set(index, {
        after: ` ${SIGN[row.kind]}`,
        afterColor: row.kind === "add" ? theme.diffAddText : theme.diffDelText,
      })
      const bg = row.kind === "add" ? theme.diffAdd : theme.diffDel
      if (bg) colors.set(index, { gutter: bg, content: bg })
    })
    if (!gutter) return
    gutter.setLineNumbers(numbers)
    gutter.setHideLineNumbers(hidden)
    gutter.setLineSigns(signs)
    gutter.setLineColors(colors)
  })
  return (
    <line_number ref={(element: LineNumberRenderable) => (gutter = element)} fg={theme.frame} paddingRight={0}>
      <code
        content={content()}
        filetype={props.filetype}
        syntaxStyle={syntaxStyle()}
        fg={theme.text}
        wrapMode="char"
        flexGrow={1}
      />
    </line_number>
  )
}

// A new file shows its last lines; an edit shows its first ones.
export function DiffView(props: { rows: DiffRow[]; tail: boolean; expanded: boolean; filetype?: string }) {
  const digits = () => String(Math.max(0, ...props.rows.map((row) => (row.kind === "gap" ? 0 : row.number)))).length
  const tail = () => props.tail && !props.expanded
  const limit = () => (props.expanded ? EXPANDED_LIMIT : props.tail ? TAIL_LIMIT : HEAD_LIMIT)
  const hidden = () => Math.max(0, props.rows.length - limit())
  const shown = () => {
    if (hidden() === 0) return props.rows
    return tail() ? props.rows.slice(-limit()) : props.rows.slice(0, limit())
  }
  const note = (text: string) => `${" ".repeat(digits() + 1)}… ${text}`

  return (
    <box flexDirection="column" paddingLeft={2}>
      <Show when={tail() && hidden() > 0}>
        <text fg={theme.muted}>{note(`${hidden()} lines above`)}</text>
      </Show>
      <Show
        when={props.filetype}
        fallback={<Index each={shown()}>{(row) => <DiffLine row={row()} digits={digits()} />}</Index>}
      >
        {(filetype) => <SyntaxRows rows={shown()} filetype={filetype()} />}
      </Show>
      <Show when={!tail() && hidden() > 0}>
        <text fg={theme.muted}>{note(`${hidden()} more lines`)}</text>
      </Show>
    </box>
  )
}
