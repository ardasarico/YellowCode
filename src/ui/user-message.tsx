import type { BorderCharacters, ImageRenderable, TextRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js"
import type { Command } from "../input/commands.ts"
import { highlightRanges } from "../input/token.ts"
import type { UserImage, UserMessage } from "../session/types.ts"
import { theme } from "../theme/theme.ts"

const COLLAPSED_ROWS = 8
const TILE_ROWS = 6
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

function ImageTile(props: { image: UserImage; index: number }) {
  let element: ImageRenderable | undefined
  const [imageWidth, setImageWidth] = createSignal(0)
  const caption = () => `Image ${props.index + 1}`
  const source = createMemo(() => Uint8Array.fromBase64(props.image.data))

  return (
    <box
      backgroundColor={theme.tile ?? undefined}
      width={Math.max(imageWidth(), caption().length) + 2}
      flexDirection="column"
      alignItems="center"
      flexShrink={0}
    >
      <image
        ref={(image) => (element = image)}
        source={source()}
        fit="fit"
        width={imageWidth()}
        height={TILE_ROWS}
        onLoad={() => setImageWidth(element?.getFittedSize(1000, TILE_ROWS).width ?? 0)}
      />
      <text fg={theme.muted}>{caption()}</text>
    </box>
  )
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
  return kind === "image" ? theme.accent : kind === "token" ? theme.dimAccent : theme.text
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
  onOverflow: (id: string, overflowing: boolean) => void
}) {
  let text: TextRenderable | undefined
  const [rows, setRows] = createSignal(0)
  const update = () => setRows(text?.virtualLineCount ?? 0)
  const hidden = () => (props.expanded ? 0 : Math.max(0, rows() - COLLAPSED_ROWS))

  onMount(() => {
    text?.on("line-info-change", update)
    update()
  })
  onCleanup(() => text?.off("line-info-change", update))
  createEffect(() => props.onOverflow(props.item.id, rows() > COLLAPSED_ROWS))

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
          <For each={props.item.images}>{(image, index) => <ImageTile image={image} index={index()} />}</For>
        </box>
      </Show>
      <text
        ref={(element) => (text = element)}
        fg={theme.text}
        wrapMode="word"
        height={hidden() > 0 ? COLLAPSED_ROWS : "auto"}
      >
        <MessageText text={props.item.text} commands={props.commands} />
      </text>
      <Show when={hidden() > 0}>
        <text fg={theme.muted}>{`+${hidden()} lines`}</text>
      </Show>
    </box>
  )
}
