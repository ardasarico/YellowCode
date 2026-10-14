import { For, Show } from "solid-js"
import type { Chip, PlacedChip } from "../input/draft.ts"
import { ImageTile } from "./image-tile.tsx"

type ImageChip = Extract<Chip, { kind: "image" }>

// The thumbnails of a draft's image chips, followed by one blank row; nothing while there is no image chip.
export function ImageStrip(props: { chips: PlacedChip[]; marginLeft?: number; onRows?: (rows: number) => void }) {
  const images = () => props.chips.flatMap(({ chip }) => (chip.kind === "image" ? [chip] : []))
  return (
    <Show when={images().length > 0}>
      <box
        flexDirection="row"
        flexWrap="wrap"
        gap={1}
        marginLeft={props.marginLeft}
        marginBottom={1}
        flexShrink={0}
        onSizeChange={function () {
          props.onRows?.(this.height + 1)
        }}
      >
        <For each={images()}>
          {(chip: ImageChip) => <ImageTile image={{ data: chip.image.base64 }} caption={`Image ${chip.n}`} />}
        </For>
      </box>
    </Show>
  )
}
