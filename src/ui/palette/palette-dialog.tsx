import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, Index, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { Frame } from "../dialog/frame.tsx"
import { type DialogLine, scrollWindow } from "../dialog/list.ts"
import { Footer, Line, onAccent, PAD_X, printable } from "../dialog/list-view.tsx"
import { SearchField } from "../dialog/search-field.tsx"
import { cut } from "../format.ts"
import { type PaletteRow, type RankedRow, rankRows } from "./rows.ts"

const WIDTH = 88
const FULL_WIDTH_MARGIN = 6
const LIST_ROWS = 14
// The title and the blank under it, the search field and its blank, the blank over the footer, the footer, and one
// padding row on each side.
const FIXED_ROWS = 2 + 3 + 2 + 2
const KIND_WIDTH = "command".length
const GAP = 2

const FOOTER = [
  { key: "↑↓", action: "select" },
  { key: "enter", action: "run", needsRow: true },
  { key: "esc", action: "close" },
]

const width = (text: string) => Bun.stringWidth(text)

// The name with its matched run apart, the description cut to the room left, and the right end: the kind, then the
// shortcut in a column the rows share.
function rowParts(ranked: RankedRow, room: number, shortcutWidth: number) {
  const { row, match, alias } = ranked
  const slash = row.target.kind === "command" ? "/" : ""
  const shortcut = shortcutWidth > 0 ? " ".repeat(GAP) + (row.shortcut ?? "").padStart(shortcutWidth) : ""
  const right = row.target.kind.padEnd(KIND_WIDTH) + shortcut
  const left = Math.max(0, room - width(right) - GAP)
  const shown = alias ?? row.name
  const run = match ?? { start: 0, end: 0 }
  const pieces =
    alias === undefined
      ? [`${slash}${shown.slice(0, run.start)}`, shown.slice(run.start, run.end), shown.slice(run.end)]
      : [
          `${slash}${row.name} (${shown.slice(0, run.start)}`,
          shown.slice(run.start, run.end),
          `${shown.slice(run.end)})`,
        ]
  const name = cut(pieces.join(""), left)
  const [before = "", strong = ""] = pieces
  const descriptionRoom = left - width(name) - GAP
  const description = row.description && descriptionRoom > 3 ? cut(row.description, descriptionRoom) : ""
  const used = width(name) + (description ? GAP + width(description) : 0)
  return {
    before: name.slice(0, before.length),
    strong: name.slice(before.length, before.length + strong.length),
    after: name.slice(before.length + strong.length),
    description: description ? " ".repeat(GAP) + description : "",
    gap: " ".repeat(Math.max(0, room - used - width(right))),
    right,
  }
}

// One search over everything the user can do. Enter hands the selected row to `onRun`.
export function PaletteDialog(props: { rows: PaletteRow[]; onRun: (row: PaletteRow) => void; onClose: () => void }) {
  const dimensions = useTerminalDimensions()
  const [query, setQuery] = createSignal("")
  // The row's id, so the selection stays on it when the rows change under the dialog.
  const [chosen, setChosen] = createSignal<string | null>(null)
  const ranked = createMemo(() => rankRows(props.rows, query()))
  const selected = createMemo(() =>
    Math.max(
      0,
      ranked().findIndex(({ row }) => row.id === chosen()),
    ),
  )
  const choose = (index: number) => setChosen(ranked()[index]?.row.id ?? null)
  const search = (text: string) => {
    setQuery(text)
    setChosen(null)
  }

  const panelWidth = () => (dimensions().width < WIDTH + FULL_WIDTH_MARGIN ? dimensions().width : WIDTH)
  const inner = () => Math.max(0, panelWidth() - PAD_X * 2)
  const listRows = () => Math.max(1, Math.min(LIST_ROWS, dimensions().height - 2 - FIXED_ROWS))
  const height = () => FIXED_ROWS + listRows()
  const shortcutWidth = createMemo(() => Math.max(0, ...props.rows.map((row) => width(row.shortcut ?? ""))))

  const lines = createMemo(() =>
    ranked().map(({ row }): DialogLine => ({ kind: "row", row: { id: row.id, label: row.name } })),
  )
  const scroll = createMemo<ReturnType<typeof scrollWindow>>((previous) =>
    scrollWindow(lines(), listRows(), selected(), selected(), previous?.start ?? 0),
  )
  const shown = () => ranked().slice(scroll().start, scroll().end)

  useKeyboard((key) => {
    key.stopPropagation()
    key.preventDefault()
    if (key.name === "escape" || (key.ctrl && key.name === "p")) props.onClose()
    else if (key.name === "up") choose(Math.max(0, selected() - 1))
    else if (key.name === "down") choose(Math.min(ranked().length - 1, selected() + 1))
    else if (key.name === "return") {
      const row = ranked()[selected()]?.row
      if (row) props.onRun(row)
    } else if (key.ctrl && key.name === "u") search("")
    else if (key.name === "backspace") search(Array.from(query()).slice(0, -1).join(""))
    else if (printable(key)) search(query() + key.sequence)
  })

  const Row = (rowProps: { ranked: RankedRow; selected: boolean }) => {
    const parts = () => rowParts(rowProps.ranked, inner(), shortcutWidth())
    return (
      <Show
        when={rowProps.selected}
        fallback={
          <box height={1} paddingLeft={PAD_X}>
            <text wrapMode="none">
              <span style={{ fg: theme.text }}>{parts().before}</span>
              <span style={{ fg: theme.text, bold: true }}>{parts().strong}</span>
              <span style={{ fg: theme.text }}>{parts().after}</span>
              <span style={{ fg: theme.panelMuted }}>{parts().description}</span>
              {parts().gap}
              <span style={{ fg: theme.panelMuted }}>{parts().right}</span>
            </text>
          </box>
        }
      >
        <box height={1} marginLeft={PAD_X - 3} width={inner() + 6} paddingLeft={1} backgroundColor={theme.accent}>
          <text wrapMode="none">
            <span style={{ fg: onAccent(), bold: true }}>{`● ${parts().before}${parts().strong}${parts().after}`}</span>
            <span style={{ fg: onAccent() }}>{`${parts().description}${parts().gap}${parts().right}`}</span>
          </text>
        </box>
      </Show>
    )
  }

  return (
    <Frame
      panel={{
        x: Math.floor((dimensions().width - panelWidth()) / 2),
        y: Math.max(0, Math.floor((dimensions().height - height()) / 2)),
        width: panelWidth(),
        height: height(),
      }}
    >
      <Line
        left={{ text: "Command palette", fg: theme.text }}
        right={{ text: "esc", fg: theme.panelMuted }}
        bold
        width={inner()}
      />
      <box height={1} />
      <SearchField
        query={query()}
        placeholder="Search commands, actions, models, sessions and settings"
        focused
        width={inner()}
      />
      <box height={1} />
      <box height={listRows() + 1} flexDirection="column" overflow="hidden">
        <Show when={ranked().length === 0}>
          <Line left={{ text: `Nothing matches "${query()}".`, fg: theme.panelMuted }} width={inner()} />
        </Show>
        <Show when={scroll().start > 0}>
          <Line left={{ text: `↑ ${scroll().above} more`, fg: theme.panelFaint }} width={inner()} />
        </Show>
        <Index each={shown()}>
          {(row, index) => <Row ranked={row()} selected={scroll().start + index === selected()} />}
        </Index>
        <Show when={scroll().end < ranked().length}>
          <Line left={{ text: `↓ ${scroll().below} more`, fg: theme.panelFaint }} width={inner()} />
        </Show>
      </box>
      <Footer items={FOOTER.filter((item) => !item.needsRow || ranked().length > 0)} keys width={inner()} />
    </Frame>
  )
}
