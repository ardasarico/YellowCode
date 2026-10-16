import { basename, resolve } from "node:path"
import type { ImageRenderable } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import type { ChatImage } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { loadImage } from "../image-label.tsx"
import { blank, type Cell, cellOf, createShown, sameCell, trackImage } from "../images.ts"

// Below this many chat cells an ask leaves its pictures out.
export const PICTURE_MIN_WIDTH = 70

export function askImage(path: string | undefined): ChatImage | null {
  if (!path) return null
  const full = resolve(process.cwd(), path)
  return { name: basename(full), mediaType: "", data: null, path: full }
}

// A picture fitted into `width`×`height` cells, centred; a muted box when there is nothing to show.
export function AskPicture(props: { image: ChatImage | null; width: number; height: number; onOpen?: () => void }) {
  const decoded = createMemo(() => (props.image ? loadImage(props.image)?.image : null) ?? undefined)
  const [element, setElement] = createSignal<ImageRenderable>()
  const [cell, setCell] = createSignal<Cell | null>(null, { equals: sameCell })
  const size = () => {
    const image = decoded()
    const shape = cell()
    const ratio = shape ? shape.height / shape.width : 2
    const fitted = image && element()?.getFittedSize(props.width, props.height, ratio, image.width, image.height)
    return fitted ?? { width: props.width, height: props.height }
  }
  const shown = createShown(
    decoded,
    cell,
    () => size().width,
    () => size().height,
  )
  return (
    <box
      width={props.width}
      height={props.height}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      onMouseDown={(event) => {
        if (!props.onOpen || !decoded()) return
        event.preventDefault()
        props.onOpen()
      }}
    >
      <Show
        when={decoded()}
        fallback={
          <box
            width={props.width}
            height={props.height}
            border
            borderStyle="rounded"
            borderColor={theme.frame}
            alignItems="center"
            justifyContent="center"
          >
            <text fg={theme.faint}>no preview</text>
          </box>
        }
      >
        <Show when={!blank()} fallback={<box width={size().width} height={size().height} />}>
          <image
            ref={(image) => {
              setElement(image)
              trackImage(image)
            }}
            renderBefore={function () {
              setCell(cellOf(this))
            }}
            source={shown()}
            fit="fit"
            width={size().width}
            height={size().height}
          />
        </Show>
      </Show>
    </box>
  )
}
