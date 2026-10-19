import { RGBA, TextAttributes } from "@opentui/core"
import { Index, Show } from "solid-js"
import { theme } from "../theme/theme.ts"
import { cut } from "./format.ts"
import { invertCells } from "./invert.ts"

export type Suggestion =
  | {
      kind: "command"
      name: string
      description: string
      argumentHint: string
      match: { start: number; end: number }
      alias?: string
    }
  | { kind: "file"; path: string }
  | { kind: "value"; value: string; note: string }

const MAX_SUGGESTION_ROWS = 6
const INDENT = 2
const CLEAR = RGBA.fromValues(0, 0, 0, 0)

export function suggestionRows(count: number, room: number): number {
  return Math.max(0, Math.min(MAX_SUGGESTION_ROWS, count, room))
}

type Part = { text: string; fg: RGBA; strong?: boolean }

// The label is cut as one string, then split back at the pieces' offsets so a cut keeps each piece's look.
function labelParts(pieces: Part[], note: string, width: number): Part[] {
  const name = cut(pieces.map((piece) => piece.text).join(""), width)
  const room = width - Bun.stringWidth(name) - 2
  const flat = note.replace(/\s+/g, " ").trim()
  const description = flat && room > 0 ? cut(flat, room) : ""
  let start = 0
  const parts = pieces.map((piece) => {
    const text = name.slice(start, start + piece.text.length)
    start += piece.text.length
    return { ...piece, text }
  })
  return [...parts, { text: description ? `  ${description}` : "", fg: theme.muted }]
}

function commandPieces(entry: Extract<Suggestion, { kind: "command" }>): Part[] {
  const { start, end } = entry.match
  if (entry.alias === undefined) {
    return [
      { text: `/${entry.name.slice(0, start)}`, fg: theme.text },
      { text: entry.name.slice(start, end), fg: theme.text, strong: true },
      { text: entry.name.slice(end), fg: theme.text },
    ]
  }
  return [
    { text: `/${entry.name} `, fg: theme.text },
    { text: `(${entry.alias.slice(0, start)}`, fg: theme.muted },
    { text: entry.alias.slice(start, end), fg: theme.text, strong: true },
    { text: `${entry.alias.slice(end)})`, fg: theme.muted },
  ]
}

function fileParts(path: string, width: number): Part[] {
  const bare = path.endsWith("/") ? path.slice(0, -1) : path
  const split = bare.lastIndexOf("/") + 1
  const name = cut(path.slice(split), width)
  const room = width - Bun.stringWidth(name)
  return [
    { text: room > 0 ? cut(path.slice(0, split), room) : "", fg: theme.muted },
    { text: name, fg: theme.text },
  ]
}

// The rows a filled list adds around its entries: one empty row on top, and one below when the shade sets it apart
// from the tile. Without a shade the tile's own blank top row keeps the list and the input apart.
export function filledPadding(): { top: number; bottom: number } {
  return { top: 1, bottom: theme.dimTile ? 1 : 0 }
}

// `indent` lines the entries up with the typed text. `filled` paints the list a shade darker than the welcome tile,
// with an accent selection, so the change of colour is what separates it from the input; without a tile colour it
// falls back to the plain look.
export function SuggestionList(props: {
  entries: Suggestion[]
  selected: number
  width: number
  indent?: number
  filled?: boolean
}) {
  const indent = () => props.indent ?? INDENT
  const shade = () => (props.filled ? theme.dimTile : null)
  const textWidth = () => Math.max(0, props.width - indent() * (shade() ? 2 : 1))
  const selectionFill = () => (shade() ? theme.accent : theme.selection)
  const padding = () => (props.filled ? filledPadding() : { top: 0, bottom: 0 })
  const height = () => props.entries.length + padding().top + padding().bottom

  return (
    <Show when={props.entries.length > 0}>
      <box
        position="absolute"
        top={-height()}
        left={0}
        zIndex={1}
        width={props.width}
        height={height()}
        flexDirection="column"
        backgroundColor={shade() ?? theme.canvas}
      >
        <box height={padding().top} flexShrink={0} />
        <Index each={props.entries}>
          {(entry, index) => {
            const selected = () => index === props.selected
            const onAccent = () => (selected() && shade() ? (theme.background ?? shade()) : null)
            const parts = () => {
              const value = entry()
              if (value.kind === "command") return labelParts(commandPieces(value), value.description, textWidth())
              if (value.kind === "value")
                return labelParts([{ text: value.value, fg: theme.text }], value.note, textWidth())
              return fileParts(value.path, textWidth())
            }
            return (
              <box height={1} paddingLeft={indent()} backgroundColor={(selected() ? selectionFill() : null) ?? CLEAR}>
                <text wrapMode="none" attributes={onAccent() ? TextAttributes.BOLD : TextAttributes.NONE}>
                  <Index each={parts()}>
                    {(part) => (
                      <span
                        style={{
                          fg: onAccent() ?? part().fg,
                          bold: part().strong,
                        }}
                      >
                        {part().text}
                      </span>
                    )}
                  </Index>
                </text>
              </box>
            )
          }}
        </Index>
        <Show when={selectionFill() === null}>
          <box
            position="absolute"
            top={props.selected + padding().top}
            left={0}
            zIndex={1}
            width={props.width}
            height={1}
            renderAfter={function () {
              invertCells(this, undefined)
            }}
          />
        </Show>
      </box>
    </Show>
  )
}
