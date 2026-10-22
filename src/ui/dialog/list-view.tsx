import { type KeyEvent, RGBA, TextAttributes } from "@opentui/core"
import { createMemo, Index, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { cut } from "../format.ts"
import type { Span } from "../notice.ts"
import {
  type DialogLine,
  type DialogRow,
  type DialogSection,
  type DialogText,
  isRow,
  MORE_MIN_ROWS,
  scrollWindow,
} from "./list.ts"

// An action that works on the selected row is hidden while no row matches.
export type FooterAction = { action: string; key: string; needsRow?: boolean }

export const PAD_X = 4

export function printable(key: KeyEvent): boolean {
  const code = key.sequence.charCodeAt(0)
  return !key.ctrl && !key.meta && code >= 32 && code !== 127
}

export const fill = () => theme.background ?? theme.tile ?? theme.canvas
export const onAccent = () => theme.background ?? RGBA.fromIndex(0)
const width = (text: string) => Bun.stringWidth(text)

function spread(left: string, right: string, room: number) {
  const value = cut(right, room)
  const label = cut(left, Math.max(0, room - width(value) - 1))
  return { label, gap: " ".repeat(Math.max(0, room - width(label) - width(value))), value }
}

function rowParts(row: DialogRow, value: string, room: number, tagColumn: number) {
  const right = value ? cut(value, room) : ""
  const left = Math.max(0, room - width(right) - (right ? 1 : 0))
  let label = cut(row.label, left)
  let tag = ""
  if (row.tag && tagColumn > 0 && left > tagColumn) {
    label = cut(row.label, Math.min(left, tagColumn - 2))
    tag = cut(`${" ".repeat(tagColumn - width(label))}${row.tag}`, left - width(label))
  }
  const gap = " ".repeat(Math.max(0, room - width(label) - width(tag) - width(right)))
  return { label, tag, pad: "", detail: "", gap, value: right }
}

function detailParts(row: DialogRow, value: string, room: number, column: number) {
  const right = value ? cut(value, room) : ""
  const left = Math.max(0, room - width(right) - (right ? 1 : 0))
  const head = Math.min(column - 1, left)
  const label = cut(row.label, head)
  const tag = row.tag && head - width(label) > 1 ? cut(` ${row.tag}`, head - width(label)) : ""
  const detail = row.detail && left > column ? cut(row.detail, left - column) : ""
  const pad = detail ? " ".repeat(Math.max(0, column - width(label) - width(tag))) : ""
  const gap = " ".repeat(Math.max(0, room - width(label) - width(tag) - width(pad) - width(detail) - width(right)))
  return { label, tag, pad, detail, gap, value: right }
}

function cutSpans(spans: Span[], room: number): Span[] {
  const kept: Span[] = []
  let left = room
  for (const span of spans) {
    if (left <= 0) break
    const text = cut(span.text, left)
    kept.push({ ...span, text })
    left -= width(text)
  }
  return kept
}

export function Line(props: { left: Span; right?: Span; bold?: boolean; width: number; pad?: number }) {
  const parts = () => spread(props.left.text, props.right?.text ?? "", props.width)
  return (
    <box height={1} paddingLeft={props.pad ?? PAD_X}>
      <text wrapMode="none">
        <span style={{ fg: props.left.fg, bold: props.bold }}>{parts().label}</span>
        {parts().gap}
        <span style={{ fg: props.right?.fg }}>{parts().value}</span>
      </text>
    </box>
  )
}

export function SearchRow(props: { query: string; placeholder?: string; pad?: number; cursor?: boolean }) {
  const Cursor = () => (
    <Show when={props.cursor ?? true} fallback=" ">
      <span style={{ bg: theme.text }}> </span>
    </Show>
  )
  return (
    <box height={1} paddingLeft={props.pad ?? PAD_X}>
      <Show
        when={props.query}
        fallback={
          <text wrapMode="none">
            <Cursor />
            <span style={{ fg: theme.panelMuted }}>{props.placeholder ?? "Search"}</span>
          </text>
        }
      >
        <text wrapMode="none">
          <span style={{ fg: theme.text }}>{props.query}</span>
          <Cursor />
        </text>
      </Show>
    </box>
  )
}

const actionsWidth = (items: FooterAction[], separator: number) =>
  items.reduce((sum, item, index) => sum + width(`${item.key} ${item.action}`) + (index ? separator : 0), 0)

// "keys" draws each action as `key action`, joined by a faint dot; the notice sits at the right end, and takes
// the whole line when it does not fit next to the actions.
// With `fit`, the actions that do not fit are left out for a "…".
export function Footer(props: {
  items: FooterAction[]
  keys?: boolean
  notice?: string
  width: number
  fit?: boolean
}) {
  const separator = () => (props.keys ? 3 : 2)
  const fitted = () => {
    if (!props.fit || actionsWidth(props.items, separator()) <= props.width) return props.items
    const more = { key: "…", action: "" }
    const kept = [...props.items]
    while (kept.length > 0 && actionsWidth([...kept, more], separator()) > props.width) kept.pop()
    return [...kept, more]
  }
  const itemsWidth = () => actionsWidth(fitted(), separator())
  const crowded = () => Boolean(props.notice) && props.width - itemsWidth() - 2 < width(props.notice ?? "")
  const items = () => (crowded() ? [] : fitted())
  const hintsWidth = () => (crowded() ? 0 : itemsWidth())
  const notice = () => {
    const room = props.width - hintsWidth() - 2
    return props.notice && room > 0 ? cut(props.notice, room) : ""
  }
  return (
    <box height={1} paddingLeft={PAD_X}>
      <text wrapMode="none">
        <Index each={items()}>
          {(item, index) => (
            <Show
              when={props.keys}
              fallback={
                <>
                  <span style={{ fg: theme.text }}>{`${index === 0 ? "" : "  "}${item().action}`}</span>
                  <span style={{ fg: theme.panelMuted }}>{` ${item().key}`}</span>
                </>
              }
            >
              <span style={{ fg: theme.panelFaint }}>{index === 0 ? "" : " · "}</span>
              <span style={{ fg: theme.text }}>{item().key}</span>
              <span style={{ fg: theme.panelMuted }}>{` ${item().action}`}</span>
            </Show>
          )}
        </Index>
        <Show when={notice()}>
          {" ".repeat(Math.max(0, props.width - hintsWidth() - width(notice())))}
          <span style={{ fg: theme.warning }}>{notice()}</span>
        </Show>
      </text>
    </box>
  )
}

const BarText = (barProps: { head: string; parts: ReturnType<typeof rowParts> }) => (
  <text wrapMode="none">
    <span style={{ fg: onAccent(), bold: true }}>{`${barProps.head}${barProps.parts.label}`}</span>
    <span style={{ fg: onAccent() }}>{barProps.parts.tag}</span>
    <span style={{ fg: onAccent(), bold: true }}>
      {`${barProps.parts.pad}${barProps.parts.detail}${barProps.parts.gap}${barProps.parts.value}`}
    </span>
  </text>
)

export type ListViewProps = {
  // Every row of the view, so the shared columns stay put while a search narrows the lines.
  sections: DialogSection[]
  lines: DialogLine[]
  selected: string | undefined
  // A new view starts scrolled to the top.
  view: string
  rows: number
  width: number
  pad?: number
  detailColumn?: number
  inset?: boolean
}

// The selected row's bar reaches three columns past the text on both sides and draws ● for a row with no marker.
// With `inset` it spans just the text and the marker stays outside it.
export function ListView(props: ListViewProps) {
  const pad = () => props.pad ?? PAD_X
  const tagColumn = createMemo(() => {
    const rows = props.sections.flatMap((section) => section.rows).filter(isRow)
    if (!rows.some((row) => row.tag)) return 0
    return Math.min(Math.max(...rows.map((row) => width(row.label))) + 2, Math.floor(props.width / 2))
  })
  const detailColumn = createMemo(() => {
    if (props.detailColumn !== undefined) return props.detailColumn
    const rows = props.sections
      .flatMap((section) => section.rows)
      .filter(isRow)
      .filter((row) => row.detail !== undefined)
    if (rows.length === 0) return 0
    const widest = Math.max(...rows.map((row) => width(row.label) + (row.tag ? 1 + width(row.tag) : 0)))
    return Math.min(widest + 3, Math.floor(props.width * 0.45))
  })

  // The last row also brings the lines under it into view, as far as they fit.
  const focus = () => {
    const index = props.lines.findIndex((line) => line.kind === "row" && line.row.id === props.selected)
    if (index === -1) return { from: 0, to: 0 }
    const from = props.lines[index - 1]?.kind === "title" ? index - 1 : index
    const to = props.lines[index + 1]?.kind === "note" ? index + 1 : index
    const last = props.lines.findLastIndex((line) => line.kind === "row") === index
    return { from, to: last ? Math.max(to, Math.min(props.lines.length - 1, from + props.rows - 2)) : to }
  }
  const scroll = createMemo<{ view: string; window: ReturnType<typeof scrollWindow> }>((previous) => {
    const start = previous?.view === props.view ? previous.window.start : 0
    const { from, to } = focus()
    return { view: props.view, window: scrollWindow(props.lines, props.rows, from, to, start) }
  })
  const shown = () => props.lines.slice(scroll().window.start, scroll().window.end)

  const TextLine = (textProps: { text: DialogText }) => {
    const indent = () => textProps.text.indent ?? 0
    return (
      <box height={1} paddingLeft={pad() + indent()}>
        <text wrapMode="none">
          <Index each={cutSpans(textProps.text.spans, props.width - indent())}>
            {(span) => <span style={{ fg: span().fg, bold: span().bold }}>{span().text}</span>}
          </Index>
        </text>
      </box>
    )
  }

  const Row = (rowProps: { row: DialogRow }) => {
    const selected = () => rowProps.row.id === props.selected
    const value = () => (selected() ? (rowProps.row.selectedValue ?? rowProps.row.value) : rowProps.row.value) ?? ""
    const parts = () =>
      rowProps.row.detail !== undefined
        ? detailParts(rowProps.row, value(), props.width, detailColumn())
        : rowParts(rowProps.row, value(), props.width, tagColumn())
    return (
      <Show
        when={selected()}
        fallback={
          <box height={1} paddingLeft={pad() - 2}>
            <text wrapMode="none">
              <span style={{ fg: rowProps.row.marker?.fg }}>{`${rowProps.row.marker?.text ?? " "} `}</span>
              <span style={{ fg: rowProps.row.labelColor ?? theme.text }}>{parts().label}</span>
              <span style={{ fg: theme.panelFaint }}>{parts().tag}</span>
              <Show when={parts().detail}>
                {parts().pad}
                <span style={{ fg: rowProps.row.valueColor ?? theme.panelMuted }}>{parts().detail}</span>
              </Show>
              {parts().gap}
              <span style={{ fg: rowProps.row.valueColor ?? theme.panelMuted }}>{parts().value}</span>
            </text>
          </box>
        }
      >
        <Show
          when={props.inset}
          fallback={
            <box
              height={1}
              marginLeft={pad() - 3}
              width={props.width + 6}
              paddingLeft={1}
              backgroundColor={theme.accent}
            >
              <BarText head={`${rowProps.row.marker?.text ?? "●"} `} parts={parts()} />
            </box>
          }
        >
          <box height={1} paddingLeft={pad() - 2} flexDirection="row">
            <text width={2} wrapMode="none">
              <span style={{ fg: rowProps.row.marker?.fg }}>{`${rowProps.row.marker?.text ?? " "} `}</span>
            </text>
            <box width={props.width} backgroundColor={theme.accent}>
              <BarText head="" parts={parts()} />
            </box>
          </box>
        </Show>
      </Show>
    )
  }

  const lineView = (line: DialogLine) => {
    if (line.kind === "row") return <Row row={line.row} />
    if (line.kind === "text") return <TextLine text={line.text} />
    if (line.kind === "note")
      return <Line left={{ text: line.text, fg: theme.panelMuted }} width={props.width} pad={pad()} />
    if (line.kind === "gap") return <box height={1} />
    return (
      <box height={1} paddingLeft={pad()}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
          {cut(line.text, props.width)}
        </text>
      </box>
    )
  }

  return (
    <>
      <Show when={scroll().window.start > 0 && props.rows >= MORE_MIN_ROWS}>
        <Line
          left={{ text: `↑ ${scroll().window.above} more`, fg: theme.panelFaint }}
          width={props.width}
          pad={pad()}
        />
      </Show>
      <Index each={shown()}>{(line) => <>{lineView(line())}</>}</Index>
      <Show when={scroll().window.end < props.lines.length && props.rows >= MORE_MIN_ROWS}>
        <Line
          left={{ text: `↓ ${scroll().window.below} more`, fg: theme.panelFaint }}
          width={props.width}
          pad={pad()}
        />
      </Show>
    </>
  )
}
