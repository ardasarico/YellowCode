import type { ImageRenderable } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import { theme } from "../theme/theme.ts"
import { blank, trackImage } from "./images.ts"

const TILE_ROWS = 6

export function ImageTile(props: { image: { data: string }; caption: string }) {
  let element: ImageRenderable | undefined
  const [imageWidth, setImageWidth] = createSignal(0)
  const source = createMemo(() => Uint8Array.fromBase64(props.image.data))

  return (
    <box
      backgroundColor={theme.tile ?? undefined}
      width={Math.max(imageWidth(), props.caption.length) + 2}
      flexDirection="column"
      alignItems="center"
      flexShrink={0}
    >
      <Show when={!blank()} fallback={<box width={imageWidth()} height={TILE_ROWS} />}>
        <image
          ref={(image) => {
            element = image
            trackImage(image)
          }}
          source={source()}
          fit="fit"
          width={imageWidth()}
          height={TILE_ROWS}
          onLoad={() => setImageWidth(element?.getFittedSize(1000, TILE_ROWS).width ?? 0)}
        />
      </Show>
      <text fg={theme.muted}>{props.caption}</text>
    </box>
  )
}
