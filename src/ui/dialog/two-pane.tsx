import type { KeyEvent } from "@opentui/core"
import { createMemo, createSignal, For, Show, untrack } from "solid-js"
import { theme } from "../../theme/theme.ts"
import {
  type DialogItem,
  type DialogLine,
  type DialogRow,
  type DialogSection,
  dialogLines,
  filterSections,
  isRow,
  moveSelection,
  selectableIds,
} from "./list.ts"
import { type FooterAction, ListView, onAccent, PAD_X, printable } from "./list-view.tsx"
import { SearchField } from "./search-field.tsx"
import { searchFooter, type TabApi } from "./tabbed-dialog.tsx"

export type TwoPaneProps = {
  api: TabApi
  sections: DialogSection[]
  filter?: (sections: DialogSection[], query: string) => DialogSection[]
  searchPlaceholder: string
  empty: (query: string) => string
  // The right pane, `width` columns wide: text lines and rows Enter runs, with the actions side by side under it.
  detail: (row: DialogRow, width: number) => DialogItem[]
  actions: (row: DialogRow) => DialogRow[]
  // Enter on an action or on a row of the detail.
  onAction: (row: DialogRow, action: DialogRow) => void
  // Sees the keys of the list pane first; returning true keeps the pane from handling them.
  onKey?: (key: KeyEvent, row: DialogRow | undefined, query: string) => boolean
  // The list pane's footer; the actions have their own.
  footer: (row: DialogRow) => FooterAction[]
}

const NARROW_BELOW = 90
const MIN_LIST = 28
const LIST_SHARE = 0.4
// The search row, its underline and the blank under it.
const SEARCH_ROWS = 3
// The blank columns between each pane's selected bar and the `│`.
const GAP = 2

// The blank, the rule and the actions under the detail.
const ACTION_ROWS = 3
const ACTION_GAP = "   "

const DETAIL_FOOTER: FooterAction[] = [
  { key: "←→", action: "select" },
  { key: "enter", action: "choose" },
  { key: "esc", action: "back" },
]

const textLines = (lines: DialogLine[], text: string): DialogLine[] =>
  lines.length > 0 ? lines : [{ kind: "text", text: { id: "empty", spans: [{ text, fg: theme.panelMuted }] } }]

// The list on the left and the selected row's detail on the right; under an inner width of 90 the detail takes
// the list's place while it has the focus.
export function TwoPane(props: TwoPaneProps) {
  const [query, setQuery] = createSignal("")
  const [chosen, setChosen] = createSignal<string>()
  const [pane, setPane] = createSignal<"list" | "detail">("list")
  const [focus, setFocus] = createSignal<string>()

  const visible = createMemo(() => (props.filter ?? filterSections)(props.sections, query()))
  const ids = createMemo(() => selectableIds(visible()))
  // No chosen row means the search row has the focus.
  const selectedId = () => {
    const id = chosen()
    if (id === undefined) return undefined
    return ids().includes(id) ? id : ids()[0]
  }
  const selectedRow = () =>
    visible()
      .flatMap((section) => section.rows)
      .filter(isRow)
      .find((row) => row.id === selectedId())

  const narrow = () => props.api.width() < NARROW_BELOW
  const listWidth = () =>
    narrow() ? props.api.width() : Math.max(MIN_LIST, Math.floor(props.api.width() * LIST_SHARE))
  const detailBox = () => props.api.width() + PAD_X - listWidth() - 1
  const detailList = () => (narrow() ? props.api.width() : detailBox() - GAP - PAD_X)

  const detailSections = createMemo((): DialogSection[] => {
    const row = selectedRow()
    return row ? [{ title: "", rows: props.detail(row, detailList()) }] : []
  })
  const actions = createMemo(() => {
    const row = selectedRow()
    return row ? props.actions(row) : []
  })
  const actionIds = () => actions().map((action) => action.id)
  const bodyIds = createMemo(() => selectableIds(detailSections()))
  const focusId = () => {
    const id = focus()
    if (id !== undefined && (actionIds().includes(id) || bodyIds().includes(id))) return id
    return actionIds()[0] ?? bodyIds()[0]
  }
  const focusedItem = () =>
    [...actions(), ...detailSections().flatMap((section) => section.rows.filter(isRow))].find(
      (row) => row.id === focusId(),
    )
  const detailFocused = () => props.api.focused() && pane() === "detail"

  const listRows = () => Math.max(0, props.api.rows() - SEARCH_ROWS)
  const listSelected = () => (props.api.focused() && pane() === "list" ? selectedId() : undefined)
  const bodySelected = () => (detailFocused() && bodyIds().includes(focusId() ?? "") ? focusId() : undefined)

  // While the detail has the focus, the list's selected row keeps an accent label.
  const marked = createMemo(() =>
    pane() === "list"
      ? visible()
      : visible().map(({ title, rows }) => ({
          title,
          rows: rows.map((row) => (isRow(row) && row.id === selectedId() ? { ...row, labelColor: theme.accent } : row)),
        })),
  )
  const listLines = createMemo(() => textLines(dialogLines(marked(), selectedId()), props.empty(query())))
  const detailLines = createMemo(() => dialogLines(detailSections(), bodySelected()))

  const search = (text: string) => {
    setQuery(text)
    setChosen(selectedId())
  }

  const listKeys = (key: KeyEvent) => {
    const row = selectedRow()
    if (props.onKey?.(key, row, query())) return true
    const id = selectedId()
    if (key.name === "up") {
      if (id === undefined) props.api.toStrip()
      else setChosen(ids().indexOf(id) <= 0 ? undefined : moveSelection(ids(), id, -1))
    } else if (key.name === "down") setChosen(moveSelection(ids(), id, 1))
    else if (key.name === "right" || key.name === "return") {
      if (!row) return true
      setFocus(undefined)
      setPane("detail")
    } else if (key.name === "escape") {
      if (!query()) return false
      search("")
    } else if (key.name === "backspace") search(Array.from(query()).slice(0, -1).join(""))
    else if (printable(key)) search(query() + key.sequence)
    return true
  }

  // ←→ move along the actions, ↑↓ between them and the rows above them.
  const detailKeys = (key: KeyEvent) => {
    const id = focusId()
    const onActions = id !== undefined && actionIds().includes(id)
    const body = bodyIds()
    if (key.name === "escape") setPane("list")
    else if (key.name === "left") {
      if (onActions && actionIds().indexOf(id) > 0) setFocus(moveSelection(actionIds(), id, -1))
      else setPane("list")
    } else if (key.name === "right") {
      if (onActions) setFocus(moveSelection(actionIds(), id, 1))
    } else if (key.name === "up") setFocus(onActions ? (body.at(-1) ?? id) : moveSelection(body, id, -1))
    else if (key.name === "down") {
      if (!onActions) setFocus(id === body.at(-1) ? (actionIds()[0] ?? id) : moveSelection(body, id, 1))
    } else if (key.name === "return") {
      const row = selectedRow()
      const item = focusedItem()
      if (row && item) props.onAction(row, item)
    }
    return true
  }

  untrack(() => props.api).bind({
    keys: (key) => (pane() === "list" ? listKeys(key) : detailKeys(key)),
    footer: () => {
      if (pane() === "detail") return DETAIL_FOOTER
      const row = selectedRow()
      return row ? props.footer(row) : searchFooter("close", props.api.tabs() > 1)
    },
  })

  const List = () => (
    <box width={listWidth() + PAD_X * (narrow() ? 2 : 1)} flexDirection="column">
      <SearchField
        query={query()}
        placeholder={props.searchPlaceholder}
        focused={props.api.focused() && selectedId() === undefined}
        width={narrow() ? listWidth() : listWidth() - GAP}
      />
      <box height={1} />
      <ListView
        sections={props.sections}
        lines={listLines()}
        selected={listSelected()}
        view="list"
        rows={listRows()}
        width={narrow() ? listWidth() : listWidth() - GAP}
        inset
      />
    </box>
  )

  // A span's style only ever adds, so each change of the focus draws new spans.
  const Actions = () => (
    <text wrapMode="none">
      <For each={actions()}>
        {(action, index) => () => {
          const selected = detailFocused() && action.id === focusId()
          return (
            <>
              <span>{index() > 0 ? ACTION_GAP : ""}</span>
              <span
                style={{
                  fg: selected ? onAccent() : theme.text,
                  bg: selected ? theme.accent : undefined,
                  bold: selected,
                }}
              >
                {action.label}
              </span>
            </>
          )
        }}
      </For>
    </text>
  )

  const Detail = (detailProps: { width: number; pad: number }) => (
    <box width={detailProps.width} flexDirection="column">
      <Show when={selectedRow()}>
        <ListView
          sections={detailSections()}
          lines={detailLines()}
          selected={bodySelected()}
          view={selectedId() ?? ""}
          rows={Math.max(0, props.api.rows() - ACTION_ROWS)}
          width={detailList()}
          pad={detailProps.pad}
          inset
        />
        <box height={1} />
        <box height={1} paddingLeft={detailProps.pad}>
          <text fg={theme.frame} wrapMode="none">
            {"─".repeat(detailList())}
          </text>
        </box>
        <box height={1} paddingLeft={detailProps.pad}>
          <Actions />
        </box>
      </Show>
    </box>
  )

  return (
    <Show
      when={!narrow()}
      fallback={
        <Show when={pane() === "detail"} fallback={<List />}>
          <Detail width={props.api.width() + PAD_X * 2} pad={PAD_X} />
        </Show>
      }
    >
      <box flexDirection="row" height={props.api.rows()}>
        <List />
        <box width={1} height={props.api.rows()}>
          <text fg={theme.frame}>{"│\n".repeat(props.api.rows()).trimEnd()}</text>
        </box>
        <Detail width={detailBox()} pad={GAP} />
      </box>
    </Show>
  )
}
