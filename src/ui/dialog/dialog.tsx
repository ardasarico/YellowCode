import { type KeyEvent, type OptimizedBuffer, RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, Index, on, onCleanup, onMount, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { cut } from "../format.ts"
import { SCRIM, setCovered } from "../images.ts"
import { DimmedImages } from "./dimmed-images.tsx"
import type { Span } from "../notice.ts"
import {
  type DialogLine,
  type DialogRow,
  type DialogSection,
  type DialogText,
  dialogLines,
  filterSections,
  isRow,
  moveSelection,
  type ScrollWindow,
  scrollWindow,
  selectableIds,
} from "./list.ts"

// An action that works on the selected row is hidden while no row matches.
export type FooterAction = { action: string; key: string; needsRow?: boolean }

export type DialogProps = {
  title: string
  width?: number
  sections: DialogSection[]
  // A function follows the selected row.
  footer: FooterAction[] | ((row: DialogRow | undefined) => FooterAction[])
  view: string
  initialSelected?: string
  // Without the search row, typing does nothing.
  search?: boolean
  // Shorter views keep this height, so the panel does not jump as views change.
  minHeight?: number
  onEnter: (row: DialogRow) => void
  onSelect?: (row: DialogRow) => void
  // Sees every key first; returning true keeps the dialog from handling it.
  onKey: (key: KeyEvent, row: DialogRow | undefined) => boolean
  onEscape: () => void
  empty?: (query: string) => string
}

const WIDTH = 64
const FULL_WIDTH_MARGIN = 6
const PAD_X = 4
// The title and the blank under it, the footer, and one padding row on each side.
const FIXED_ROWS = 2 + 1 + 2
const SEARCH_ROWS = 2

function printable(key: KeyEvent): boolean {
  const code = key.sequence.charCodeAt(0)
  return !key.ctrl && !key.meta && code >= 32 && code !== 127
}

const fill = () => theme.background ?? theme.tile ?? theme.canvas
const onAccent = () => theme.background ?? RGBA.fromIndex(0)
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
  return { label, tag, gap, value: right }
}

function cutSpans(spans: Span[], room: number): Span[] {
  const kept: Span[] = []
  let left = room
  for (const span of spans) {
    if (left <= 0) break
    const text = cut(span.text, left)
    kept.push({ text, fg: span.fg })
    left -= width(text)
  }
  return kept
}

export function Dialog(props: DialogProps) {
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  onMount(() => setCovered(true))
  onCleanup(() => setCovered(false))
  const [query, setQuery] = createSignal("")
  const [chosen, setChosen] = createSignal(props.initialSelected)
  createEffect(
    on(
      () => props.view,
      () => {
        setQuery("")
        setChosen(props.initialSelected)
      },
      { defer: true },
    ),
  )

  const searching = () => props.search ?? true
  const visible = createMemo(() => filterSections(props.sections, query()))
  const ids = createMemo(() => selectableIds(visible()))
  const selectedId = () =>
    [chosen(), props.initialSelected].find((id) => id !== undefined && ids().includes(id)) ?? ids()[0]
  const selectedRow = () =>
    visible()
      .flatMap((section) => section.rows)
      .filter(isRow)
      .find((row) => row.id === selectedId())

  createEffect(
    on(createMemo(selectedId), () => {
      const row = selectedRow()
      if (row) props.onSelect?.(row)
    }),
  )

  const panelWidth = () => {
    const panel = props.width ?? WIDTH
    return dimensions().width < panel + FULL_WIDTH_MARGIN ? dimensions().width : panel
  }
  const inner = () => Math.max(0, panelWidth() - PAD_X * 2)
  // Measured on every row, so the column stays put while a search narrows the list.
  const tagColumn = createMemo(() => {
    const rows = props.sections.flatMap((section) => section.rows).filter(isRow)
    if (!rows.some((row) => row.tag)) return 0
    return Math.min(Math.max(...rows.map((row) => width(row.label))) + 2, Math.floor(inner() / 2))
  })
  const lines = createMemo((): DialogLine[] => {
    const body = dialogLines(visible(), selectedId())
    const text = body.length === 0 ? props.empty?.(query()) : undefined
    return text ? [{ kind: "text", text: { id: "empty", spans: [{ text, fg: theme.muted }] } }] : body
  })
  const fixedRows = () => FIXED_ROWS + (searching() ? SEARCH_ROWS : 0)
  // The blank row above the footer belongs to the line area, so an empty view adds no rows.
  const natural = () => fixedRows() + (lines().length > 0 ? lines().length + 1 : 0)
  const height = () => Math.min(Math.max(natural(), props.minHeight ?? 0), dimensions().height - 2)
  const areaRows = () => Math.max(0, height() - fixedRows())
  const lineRows = () => Math.max(0, areaRows() - (lines().length > 0 ? 1 : 0))

  const focus = () => {
    const index = lines().findIndex((line) => line.kind === "row" && line.row.id === selectedId())
    if (index === -1) return { from: 0, to: 0 }
    const from = lines()[index - 1]?.kind === "title" ? index - 1 : index
    return { from, to: lines()[index + 1]?.kind === "note" ? index + 1 : index }
  }
  const scroll = createMemo<{ view: string; window: ScrollWindow }>((previous) => {
    const start = previous?.view === props.view ? previous.window.start : 0
    const { from, to } = focus()
    return { view: props.view, window: scrollWindow(lines(), lineRows(), from, to, start) }
  })
  const shown = () => lines().slice(scroll().window.start, scroll().window.end)

  // The top edge stays where the tallest view put it, so views grow and shrink at the bottom.
  const tallest = createMemo((previous: number) => Math.max(previous, height()), 0)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.max(0, Math.floor((dimensions().height - Math.min(tallest(), dimensions().height - 2)) / 2))
  // With no colors to blend with, the cells around the panel are set faint, so the terminal fades them itself.
  const faint = (buffer: OptimizedBuffer) => {
    const { attributes } = buffer.buffers
    const [x0, y0, x1, y1] = [left(), top(), left() + panelWidth(), top() + height()]
    for (let y = 0; y < buffer.height; y++) {
      for (let x = 0; x < buffer.width; x++) {
        const index = y * buffer.width + x
        if (x < x0 || x >= x1 || y < y0 || y >= y1) attributes[index] = (attributes[index] ?? 0) | TextAttributes.DIM
      }
    }
  }
  createEffect(() => {
    if (theme.dim) return
    renderer.addPostProcessFn(faint)
    onCleanup(() => renderer.removePostProcessFn(faint))
  })
  const footer = () => {
    const actions = typeof props.footer === "function" ? props.footer(selectedRow()) : props.footer
    return actions.filter((item) => !item.needsRow || ids().length > 0)
  }

  useKeyboard((key) => {
    const row = selectedRow()
    key.stopPropagation()
    key.preventDefault()
    if (props.onKey(key, row)) return
    if (key.name === "up" || key.name === "down")
      setChosen(moveSelection(ids(), selectedId(), key.name === "up" ? -1 : 1))
    else if (key.name === "return") {
      if (row) props.onEnter(row)
    } else if (key.name === "escape") props.onEscape()
    else if (!searching()) return
    else if (key.name === "backspace") setQuery((text) => text.slice(0, -1))
    else if (printable(key)) setQuery((text) => text + key.sequence)
  })

  const Line = (lineProps: { left: Span; right?: Span; bold?: boolean }) => {
    const parts = () => spread(lineProps.left.text, lineProps.right?.text ?? "", inner())
    return (
      <box height={1} paddingLeft={PAD_X}>
        <text wrapMode="none">
          <span style={{ fg: lineProps.left.fg, bold: lineProps.bold }}>{parts().label}</span>
          {parts().gap}
          <span style={{ fg: lineProps.right?.fg }}>{parts().value}</span>
        </text>
      </box>
    )
  }

  const TextLine = (textProps: { text: DialogText }) => {
    const indent = () => textProps.text.indent ?? 0
    return (
      <box height={1} paddingLeft={PAD_X + indent()}>
        <text wrapMode="none">
          <Index each={cutSpans(textProps.text.spans, inner() - indent())}>
            {(span) => <span style={{ fg: span().fg }}>{span().text}</span>}
          </Index>
        </text>
      </box>
    )
  }

  const Row = (rowProps: { row: DialogRow }) => {
    const selected = () => rowProps.row.id === selectedId()
    const value = () => (selected() ? (rowProps.row.selectedValue ?? rowProps.row.value) : rowProps.row.value) ?? ""
    const parts = () => rowParts(rowProps.row, value(), inner(), tagColumn())
    return (
      <Show
        when={selected()}
        fallback={
          <box height={1} paddingLeft={PAD_X - 2}>
            <text wrapMode="none">
              <span style={{ fg: rowProps.row.marker?.fg }}>{`${rowProps.row.marker?.text ?? " "} `}</span>
              <span style={{ fg: rowProps.row.labelColor ?? theme.text }}>{parts().label}</span>
              <span style={{ fg: theme.faint }}>{parts().tag}</span>
              {parts().gap}
              <span style={{ fg: rowProps.row.valueColor ?? theme.muted }}>{parts().value}</span>
            </text>
          </box>
        }
      >
        <box height={1} marginLeft={1} width={panelWidth() - 2} paddingLeft={1} backgroundColor={theme.accent}>
          <text wrapMode="none">
            <span style={{ fg: onAccent(), bold: true }}>{`${rowProps.row.marker?.text ?? "●"} ${parts().label}`}</span>
            <span style={{ fg: onAccent() }}>{parts().tag}</span>
            <span style={{ fg: onAccent(), bold: true }}>{`${parts().gap}${parts().value}`}</span>
          </text>
        </box>
      </Show>
    )
  }

  const lineView = (line: DialogLine) => {
    if (line.kind === "row") return <Row row={line.row} />
    if (line.kind === "text") return <TextLine text={line.text} />
    if (line.kind === "note") return <Line left={{ text: line.text, fg: theme.muted }} />
    if (line.kind === "gap") return <box height={1} />
    return (
      <box height={1} paddingLeft={PAD_X}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
          {cut(line.text, inner())}
        </text>
      </box>
    )
  }

  return (
    <>
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        zIndex={10}
        backgroundColor={theme.dim ? SCRIM : undefined}
      />
      <Show when={theme.dim}>
        <DimmedImages panel={{ x: left(), y: top(), width: panelWidth(), height: height() }} />
      </Show>
      <box
        position="absolute"
        top={top()}
        left={left()}
        zIndex={11}
        width={panelWidth()}
        height={height()}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        backgroundColor={fill()}
      >
        <Line left={{ text: props.title, fg: theme.text }} right={{ text: "esc", fg: theme.muted }} bold />
        <box height={1} />
        <Show when={searching()}>
          <box height={1} paddingLeft={PAD_X}>
            <Show
              when={query()}
              fallback={
                <text wrapMode="none">
                  <span style={{ bg: theme.text }}> </span>
                  <span style={{ fg: theme.muted }}>Search</span>
                </text>
              }
            >
              <text wrapMode="none">
                <span style={{ fg: theme.text }}>{query()}</span>
                <span style={{ bg: theme.text }}> </span>
              </text>
            </Show>
          </box>
          <box height={1} />
        </Show>
        <box height={areaRows()} flexDirection="column">
          <Show when={scroll().window.start > 0}>
            <Line left={{ text: `↑ ${scroll().window.above} more`, fg: theme.faint }} />
          </Show>
          <Index each={shown()}>{(line) => <>{lineView(line())}</>}</Index>
          <Show when={scroll().window.end < lines().length}>
            <Line left={{ text: `↓ ${scroll().window.below} more`, fg: theme.faint }} />
          </Show>
        </box>
        <box height={1} paddingLeft={PAD_X}>
          <text wrapMode="none">
            <Index each={footer()}>
              {(item, index) => (
                <>
                  <span style={{ fg: theme.text }}>{`${index === 0 ? "" : "  "}${item().action}`}</span>
                  <span style={{ fg: theme.muted }}>{` ${item().key}`}</span>
                </>
              )}
            </Index>
          </text>
        </box>
      </box>
      {/* Without a dim the panel is framed instead; the frame sits on the panel's padding cells. */}
      <Show when={!theme.dim}>
        <box
          position="absolute"
          top={top()}
          left={left()}
          zIndex={12}
          width={panelWidth()}
          height={height()}
          border
          borderColor={theme.muted}
        />
      </Show>
    </>
  )
}
