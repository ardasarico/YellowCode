import { type KeyEvent, RGBA, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Index, on, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { AskScroll } from "../ask/ask-scroll.tsx"
import { cut } from "../format.ts"
import type { Span } from "../notice.ts"
import { type DialogRow, type DialogSection, filterSections, moveSelection, selectableIds } from "./list.ts"

export type DialogProps = {
  title: string
  width?: number
  sections: DialogSection[]
  footer: Span[]
  view: string
  initialSelected?: string
  onEnter: (row: DialogRow) => void
  onKey: (key: KeyEvent, row: DialogRow | undefined) => boolean
  onEscape: () => void
  empty?: (query: string) => string
}

const WIDTH = 64
const FULL_WIDTH_MARGIN = 6
const PAD_X = 4
const DIM = RGBA.fromValues(6 / 255, 7 / 255, 12 / 255, 0.75)
// Title, blank, search row, blank above the sections; the footer below them; one padding row on each side.
const FIXED_ROWS = 4 + 1 + 2

function printable(key: KeyEvent): boolean {
  const code = key.sequence.charCodeAt(0)
  return !key.ctrl && !key.meta && code >= 32 && code !== 127
}

const fill = () => theme.background ?? theme.tile ?? RGBA.defaultBackground()
const onAccent = () => theme.background ?? RGBA.fromIndex(0)

function spread(left: string, right: string, width: number) {
  const value = cut(right, width)
  const label = cut(left, Math.max(0, width - Bun.stringWidth(value) - 1))
  return { label, gap: " ".repeat(Math.max(0, width - Bun.stringWidth(label) - Bun.stringWidth(value))), value }
}

export function Dialog(props: DialogProps) {
  const dimensions = useTerminalDimensions()
  const [query, setQuery] = createSignal("")
  const [chosen, setChosen] = createSignal(props.initialSelected)
  const [moved, setMoved] = createSignal(false)
  createEffect(
    on(
      () => props.view,
      () => {
        setQuery("")
        setChosen(props.initialSelected)
        setMoved(false)
      },
      { defer: true },
    ),
  )

  const visible = createMemo(() => filterSections(props.sections, query()))
  const ids = createMemo(() => selectableIds(visible()))
  const selectedId = () => {
    const id = chosen()
    return id !== undefined && ids().includes(id) ? id : ids()[0]
  }
  const selectedRow = () =>
    visible()
      .flatMap((section) => section.rows)
      .find((row) => row.id === selectedId())

  const width = () => {
    const panel = props.width ?? WIDTH
    return dimensions().width < panel + FULL_WIDTH_MARGIN ? dimensions().width : panel
  }
  const inner = () => Math.max(0, width() - PAD_X * 2)
  const emptyText = () => (ids().length === 0 ? props.empty?.(query()) : undefined)
  const gapAfter = (position: number) => Boolean(visible()[position]?.title) && position < visible().length - 1
  // The blank row above the footer belongs to the row area, so an empty row area adds no rows.
  const sectionRows = () => {
    const sections = visible()
    const rows = sections.reduce((sum, section) => sum + section.rows.length + (section.title ? 1 : 0), 0)
    const gaps = sections.slice(0, -1).filter((section) => section.title).length
    const content = rows + gaps + (selectedRow()?.note ? 1 : 0) + (emptyText() ? 1 : 0)
    return content === 0 ? 0 : content + 1
  }
  const scrollRows = () => Math.max(0, Math.min(sectionRows(), dimensions().height - 2 - FIXED_ROWS))
  const height = () => FIXED_ROWS + scrollRows()

  useKeyboard((key) => {
    const row = selectedRow()
    if (key.name === "up" || key.name === "down") {
      setChosen(moveSelection(ids(), selectedId(), key.name === "up" ? -1 : 1))
      setMoved(true)
    } else if (key.name === "return") {
      if (row) props.onEnter(row)
    } else if (key.name === "escape") props.onEscape()
    else if (key.name === "backspace") setQuery((text) => text.slice(0, -1))
    else if (printable(key)) setQuery((text) => text + key.sequence)
    else props.onKey(key, row)
    key.stopPropagation()
    key.preventDefault()
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

  const Row = (rowProps: { row: DialogRow }) => {
    const selected = () => rowProps.row.id === selectedId()
    const parts = () => spread(rowProps.row.label, rowProps.row.value ?? "", inner())
    return (
      <>
        <Show
          when={selected()}
          fallback={
            <Line
              left={{ text: rowProps.row.label, fg: theme.text }}
              right={{ text: rowProps.row.value ?? "", fg: theme.muted }}
            />
          }
        >
          <box height={1} marginLeft={1} width={width() - 2} paddingLeft={1} backgroundColor={theme.accent}>
            <text wrapMode="none" fg={onAccent()} attributes={TextAttributes.BOLD}>
              {`● ${parts().label}${parts().gap}${parts().value}`}
            </text>
          </box>
          <Show when={rowProps.row.note}>{(note) => <Line left={{ text: note(), fg: theme.muted }} />}</Show>
        </Show>
      </>
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
        backgroundColor={theme.background ? DIM : undefined}
      />
      <box
        position="absolute"
        top={Math.max(0, Math.floor((dimensions().height - height()) / 2))}
        left={Math.floor((dimensions().width - width()) / 2)}
        zIndex={11}
        width={width()}
        height={height()}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        backgroundColor={fill()}
      >
        <Line left={{ text: props.title, fg: theme.text }} right={{ text: "esc", fg: theme.muted }} bold />
        <box height={1} />
        <box height={1} paddingLeft={PAD_X}>
          <Show when={query()} fallback={<text fg={theme.muted}>Search</text>}>
            <text wrapMode="none">
              <span style={{ fg: theme.text }}>{query()}</span>
              <span style={{ bg: theme.text }}> </span>
            </text>
          </Show>
        </box>
        <box height={1} />
        <box height={scrollRows()} flexDirection="column">
          <AskScroll
            focus={selectedId() === undefined ? null : `dialog-row-${selectedId()}`}
            fromTop={!moved()}
            scope={props.view}
          >
            <box flexDirection="column">
              <Show when={emptyText()}>
                {(text) => (
                  <box height={1} paddingLeft={PAD_X}>
                    <text fg={theme.muted} wrapMode="none">
                      {cut(text(), inner())}
                    </text>
                  </box>
                )}
              </Show>
              <For each={visible()}>
                {(section, position) => (
                  <box flexDirection="column">
                    <Index each={section.rows}>
                      {(row, index) => (
                        // The first row carries its section header, so scrolling it into view shows the header too.
                        <box id={`dialog-row-${row().id}`} flexDirection="column">
                          <Show when={index === 0 && section.title}>
                            <box height={1} paddingLeft={PAD_X}>
                              <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
                                {cut(section.title, inner())}
                              </text>
                            </box>
                          </Show>
                          <Row row={row()} />
                        </box>
                      )}
                    </Index>
                    <Show when={gapAfter(position())}>
                      <box height={1} />
                    </Show>
                  </box>
                )}
              </For>
              <Show when={sectionRows() > 0}>
                <box height={1} />
              </Show>
            </box>
          </AskScroll>
        </box>
        <box height={1} paddingLeft={PAD_X}>
          <text wrapMode="none">
            <Index each={props.footer}>{(span) => <span style={{ fg: span().fg }}>{span().text}</span>}</Index>
          </text>
        </box>
      </box>
    </>
  )
}
