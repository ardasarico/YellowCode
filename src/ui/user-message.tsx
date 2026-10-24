import type { BorderCharacters, TextRenderable } from "@opentui/core"
import { createEffect, createSignal, Index, onCleanup, onMount, Show } from "solid-js"
import type { Command } from "../input/commands.ts"
import { highlightRanges } from "../input/token.ts"
import type { UserMessage } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { FoldHint } from "./fold-hint.tsx"
import { printable } from "./format.ts"
import { labelId } from "./image-label.tsx"
import { ImageTile } from "./image-tile.tsx"

const COLLAPSED_ROWS = 8
const BAR = "▌"
export const barChars: BorderCharacters = {
  topLeft: BAR,
  topRight: " ",
  bottomLeft: BAR,
  bottomRight: " ",
  horizontal: " ",
  vertical: BAR,
  topT: " ",
  bottomT: " ",
  leftT: BAR,
  rightT: " ",
  cross: " ",
}

type Part = { text: string; kind: "plain" | "image" | "token" }

function messageParts(text: string, commands: Command[]): Part[] {
  const images = [...text.matchAll(/\[Image \d+\]/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    kind: "image" as const,
  }))
  const tokens = highlightRanges(text, commands)
    .filter((token) => !images.some((image) => token.start < image.end && image.start < token.end))
    .map(({ start, end }) => ({ start, end, kind: "token" as const }))
  const parts: Part[] = []
  let at = 0
  for (const mark of [...images, ...tokens].toSorted((a, b) => a.start - b.start)) {
    if (mark.start > at) parts.push({ text: text.slice(at, mark.start), kind: "plain" })
    parts.push({ text: text.slice(mark.start, mark.end), kind: mark.kind })
    at = mark.end
  }
  if (at < text.length) parts.push({ text: text.slice(at), kind: "plain" })
  return parts
}

function partColor(kind: Part["kind"]) {
  return kind === "plain" ? theme.text : theme.accent
}

function MessageText(props: { text: string; commands: Command[] }) {
  return (
    <Index each={messageParts(props.text, props.commands)}>
      {(part) => <span style={{ fg: partColor(part().kind) }}>{part().text}</span>}
    </Index>
  )
}

export function UserMessageRow(props: {
  item: UserMessage
  commands: Command[]
  selected: boolean
  expanded: boolean
  selection?: string | null
  onOverflow: (id: string, overflowing: boolean) => void
  onToggle: (id: string) => void
  onOpenImage?: (id: string) => void
}) {
  let text: TextRenderable | undefined
  const [rows, setRows] = createSignal(0)
  const update = () => setRows(text?.virtualLineCount ?? 0)
  const overflowing = () => rows() > COLLAPSED_ROWS
  const collapsed = () => overflowing() && !props.expanded

  onMount(() => {
    text?.on("line-info-change", update)
    update()
  })
  onCleanup(() => text?.off("line-info-change", update))
  createEffect(() => props.onOverflow(props.item.id, overflowing()))

  return (
    <box
      id={props.item.id}
      flexDirection="column"
      backgroundColor={(props.selected ? theme.selection : theme.band) ?? undefined}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={barChars}
      paddingLeft={1}
    >
      <Show when={props.item.images.length > 0}>
        <box flexDirection="row" flexWrap="wrap" gap={1}>
          <Index each={props.item.images}>
            {(image, index) => {
              const id = labelId(props.item.id, index)
              return (
                <Show when={image().data}>
                  {(data) => (
                    <ImageTile
                      id={id}
                      image={{ data: data() }}
                      caption={`Image ${index + 1}`}
                      selected={props.selection === id}
                      onOpen={props.onOpenImage && (() => props.onOpenImage?.(id))}
                    />
                  )}
                </Show>
              )
            }}
          </Index>
        </box>
      </Show>
      <text
        ref={(element) => (text = element)}
        fg={theme.text}
        wrapMode="word"
        height={collapsed() ? COLLAPSED_ROWS : "auto"}
      >
        <Show when={props.item.to}>{(to) => <span style={{ fg: theme.accent }}>{`@${to().name} `}</span>}</Show>
        <Show
          when={/^\/goal\s+(\S[\s\S]*)$/.exec(props.item.text)?.[1]}
          fallback={<MessageText text={printable(props.item.text)} commands={props.commands} />}
        >
          {(condition) => (
            <>
              <span style={{ fg: theme.accent }}>{"◎ Goal: "}</span>
              <span style={{ fg: theme.text }}>{printable(condition())}</span>
            </>
          )}
        </Show>
        <span style={{ fg: theme.muted }}>{props.item.queue ? `  ${props.item.queue}` : ""}</span>
      </text>
      <Show when={props.item.delivery}>
        {(delivery) => (
          <text fg={theme.muted} wrapMode="none">
            {delivery() === "resumed" ? `→ ${props.item.to?.name} resumed` : `→ sent to ${props.item.to?.name}`}
          </text>
        )}
      </Show>
      <Show when={overflowing()}>
        <text
          fg={theme.muted}
          onMouseDown={(event) => {
            event.preventDefault()
            props.onToggle(props.item.id)
          }}
        >
          <FoldHint open={!collapsed()} selected={props.selected} hidden={rows() - COLLAPSED_ROWS} />
        </text>
      </Show>
    </box>
  )
}
