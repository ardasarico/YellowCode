import type { BorderCharacters, ImageRenderable, TextRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js"
import type { UserImage, UserMessage } from "../session/types.ts"
import { theme } from "../theme/theme.ts"

const COLLAPSED_ROWS = 8
const TILE_ROWS = 6
const BAR = "▌"
const barChars: BorderCharacters = {
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

function MessageText(props: { text: string }) {
  const parts = () => props.text.split(/(\[Image \d+\])/)
  return (
    <Index each={parts()}>
      {(part, index) => <span style={{ fg: index % 2 === 1 ? theme.accent : theme.text }}>{part()}</span>}
    </Index>
  )
}

export function UserMessageRow(props: {
  item: UserMessage
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
      marginTop={1}
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
        <MessageText text={props.item.text} />
      </text>
      <Show when={hidden() > 0}>
        <text fg={theme.muted}>{`+${hidden()} lines`}</text>
      </Show>
    </box>
  )
}
