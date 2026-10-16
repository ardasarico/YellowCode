import { type ImageRenderable, NativeImage } from "@opentui/core"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { theme } from "../theme/theme.ts"
import { blank, type Cell, cellOf, createShown, sameCell, trackImage } from "./images.ts"

const TILE_ROWS = 6
const OPEN = "↵ enlarge"

export function ImageTile(props: {
  id?: string
  image: { data: string }
  caption: string
  selected?: boolean
  onOpen?: () => void
}) {
  const [element, setElement] = createSignal<ImageRenderable>()
  const [cell, setCell] = createSignal<Cell | null>(null, { equals: sameCell })
  const [room, setRoom] = createSignal(0)
  const decoded = createMemo(() => {
    let image: NativeImage
    try {
      image = NativeImage.decode(Uint8Array.fromBase64(props.image.data))
    } catch {
      return undefined
    }
    onCleanup(() => image.dispose())
    return image
  })
  const imageWidth = createMemo(() => {
    const image = decoded()
    const shape = cell()
    const ratio = shape ? shape.height / shape.width : 2
    const width = room() - 2
    if (!image || width <= 0) return 0
    return element()?.getFittedSize(width, TILE_ROWS, ratio, image.width, image.height).width ?? 0
  })
  const source = createShown(decoded, cell, imageWidth, () => TILE_ROWS)
  const captionWidth = () => Math.max(props.caption.length, props.onOpen ? OPEN.length : 0)

  return (
    <box
      id={props.id}
      backgroundColor={(props.selected ? theme.selection : theme.tile) ?? undefined}
      width={Math.max(imageWidth(), captionWidth()) + 2}
      flexDirection="column"
      alignItems="center"
      flexShrink={0}
      renderBefore={function () {
        setRoom(this.parent?.width ?? 0)
      }}
      onMouseDown={(event) => {
        if (!props.onOpen) return
        event.preventDefault()
        props.onOpen()
      }}
    >
      <Show when={!blank()} fallback={<box width={imageWidth()} height={TILE_ROWS} />}>
        <image
          ref={(image) => {
            setElement(image)
            trackImage(image)
          }}
          renderBefore={function () {
            setCell(cellOf(this))
          }}
          source={source()}
          fit="fit"
          width={imageWidth()}
          height={TILE_ROWS}
        />
      </Show>
      <Show when={props.selected && props.onOpen} fallback={<text fg={theme.muted}>{props.caption}</text>}>
        <text fg={theme.accent}>{OPEN}</text>
      </Show>
    </box>
  )
}
