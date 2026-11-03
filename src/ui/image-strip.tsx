import { For, Show } from "solid-js"
import type { Chip, PlacedChip } from "../input/draft.ts"
import { ImageTile } from "./image-tile.tsx"

type ImageChip = Extract<Chip, { kind: "image" }>

export function ImageStrip(props: { chips: PlacedChip[]; marginLeft?: number; onRows?: (rows: number) => void }) {
  const images = () => props.chips.flatMap(({ chip }) => (chip.kind === "image" ? [chip] : []))
  // One row of thumbnails, so the prompt under it stays on a short screen; the chips name every image.
  return (
    <Show when={images().length > 0}>
      <box
        flexDirection="row"
        overflow="hidden"
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
