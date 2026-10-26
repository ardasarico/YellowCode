import type { KeyEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { Frame } from "./frame.tsx"
import {
  type DialogLine,
  type DialogRow,
  type DialogSection,
  type DialogText,
  dialogLines,
  filterSections,
  isRow,
  moveSelection,
  selectableIds,
} from "./list.ts"
import { Footer, type FooterAction, Line, ListView, PAD_X, printable, SearchRow } from "./list-view.tsx"

export type { FooterAction }

type DialogProps = {
  title: string
  width?: number
  sections: DialogSection[]
  // Lines under the list that stay in view while it scrolls.
  pinned?: DialogText[]
  // A function follows the selected row and the search.
  footer: FooterAction[] | ((row: DialogRow | undefined, query: string) => FooterAction[])
  view: string
  initialSelected?: string
  // Without the search row, typing does nothing.
  search?: boolean
  searchPlaceholder?: string
  filter?: (sections: DialogSection[], query: string) => DialogSection[]
  // "keys" draws each action as `key action`, joined by a faint dot.
  footerStyle?: "keys"
  // Drawn at the right end of the footer line.
  notice?: string
  // Shorter views keep this height, so the panel does not jump as views change.
  minHeight?: number
  onEnter: (row: DialogRow) => void
  onSelect?: (row: DialogRow) => void
  // Sees every key first; returning true keeps the dialog from handling it.
  onKey: (key: KeyEvent, row: DialogRow | undefined, query: string) => boolean
  onEscape: () => void
  empty?: (query: string) => string
}

const WIDTH = 64
const FULL_WIDTH_MARGIN = 6
// The title and the blank under it, the footer, and one padding row on each side.
const FIXED_ROWS = 2 + 1 + 2
const SEARCH_ROWS = 2

export function Dialog(props: DialogProps) {
  const dimensions = useTerminalDimensions()
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
  // A single group has nothing to be told apart from, so its label is left out.
  const sections = () =>
    props.sections.length === 1 ? props.sections.map((section) => ({ ...section, title: "" })) : props.sections
  const visible = createMemo(() => (props.filter ?? filterSections)(sections(), query()))
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
  const lines = createMemo((): DialogLine[] => {
    const body = dialogLines(visible(), selectedId())
    const text = body.length === 0 ? props.empty?.(query()) : undefined
    return text ? [{ kind: "text", text: { id: "empty", spans: [{ text, fg: theme.panelMuted }] } }] : body
  })
  const pinned = () => (props.pinned ?? []).map((text): DialogLine => ({ kind: "text", text }))
  const fixedRows = () => FIXED_ROWS + (searching() ? SEARCH_ROWS : 0)
  // The blank row above the footer belongs to the line area, so an empty view adds no rows.
  const natural = () => fixedRows() + (lines().length > 0 ? lines().length + pinned().length + 1 : 0)
  const height = () => Math.min(Math.max(natural(), props.minHeight ?? 0), dimensions().height - 2)
  const areaRows = () => Math.max(0, height() - fixedRows())
  const spareRows = () => Math.max(0, areaRows() - (lines().length > 0 ? 1 : 0))
  // The pinned lines leave the list at least its selected row.
  const pinnedRows = () => Math.min(pinned().length, Math.max(0, spareRows() - 1))
  const lineRows = () => spareRows() - pinnedRows()

  // The top edge stays where the tallest view put it, so views grow and shrink at the bottom.
  const tallest = createMemo((previous: number) => Math.max(previous, height()), 0)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.max(0, Math.floor((dimensions().height - Math.min(tallest(), dimensions().height - 2)) / 2))
  const footer = () => {
    const actions = typeof props.footer === "function" ? props.footer(selectedRow(), query()) : props.footer
    return actions.filter((item) => !item.needsRow || ids().length > 0)
  }

  useKeyboard((key) => {
    const row = selectedRow()
    key.stopPropagation()
    key.preventDefault()
    if (props.onKey(key, row, query())) return
    if (key.name === "up" || key.name === "down")
      setChosen(moveSelection(ids(), selectedId(), key.name === "up" ? -1 : 1))
    else if (key.name === "return") {
      if (row) props.onEnter(row)
    } else if (key.name === "escape") props.onEscape()
    else if (!searching()) return
    else if (key.name === "backspace") setQuery((text) => Array.from(text).slice(0, -1).join(""))
    else if (printable(key)) setQuery((text) => text + key.sequence)
  })

  return (
    <Frame panel={{ x: left(), y: top(), width: panelWidth(), height: height() }}>
      <Line
        left={{ text: props.title, fg: theme.text }}
        right={{ text: "esc", fg: theme.panelMuted }}
        bold
        width={inner()}
      />
      <box height={1} />
      <Show when={searching()}>
        <SearchRow query={query()} placeholder={props.searchPlaceholder} />
        <box height={1} />
      </Show>
      <box height={areaRows()} flexDirection="column" overflow="hidden">
        <ListView
          sections={props.sections}
          lines={lines()}
          selected={selectedId()}
          view={props.view}
          rows={lineRows()}
          width={inner()}
        />
        <ListView
          sections={[]}
          lines={pinned()}
          selected={undefined}
          view={props.view}
          rows={pinnedRows()}
          width={inner()}
        />
      </box>
      <Footer items={footer()} keys={props.footerStyle === "keys"} notice={props.notice} width={inner()} />
    </Frame>
  )
}
