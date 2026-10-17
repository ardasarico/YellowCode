import type { ImageRenderable } from "@opentui/core"
import { createSignal, Index, Show } from "solid-js"
import type { ChatImage } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { createDecoded, ImageLabel, labelId } from "./image-label.tsx"
import { blank, type Cell, cellOf, createShown, sameCell, trackImage } from "./images.ts"

const MAX_ROWS = 16
const GAP = 2
const MIN_SLOT = 20

function InlineImage(props: { id?: string; image: ChatImage; width: number; selected: boolean; onOpen?: () => void }) {
  const pixels = createDecoded(() => props.image)
  const [element, setElement] = createSignal<ImageRenderable>()
  const [cell, setCell] = createSignal<Cell | null>(null, { equals: sameCell })
  const size = () => {
    const decoded = pixels()
    const shape = cell()
    const ratio = shape ? shape.height / shape.width : 2
    const fitted = decoded && element()?.getFittedSize(props.width, MAX_ROWS, ratio, decoded.width, decoded.height)
    return fitted ?? { width: props.width, height: MAX_ROWS }
  }
  const shown = createShown(
    pixels,
    cell,
    () => size().width,
    () => size().height,
  )
  return (
    <Show
      when={pixels()}
      fallback={
        <ImageLabel id={props.id} image={props.image} prefix="" selected={props.selected} onOpen={props.onOpen} />
      }
    >
      {(decoded) => (
        <box
          id={props.id}
          flexDirection="column"
          flexShrink={0}
          maxWidth={props.width}
          onMouseDown={(event) => {
            if (!props.onOpen) return
            event.preventDefault()
            props.onOpen()
          }}
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
          <text wrapMode="none" fg={theme.muted} bg={props.selected ? (theme.selection ?? undefined) : undefined}>
            {`${props.image.name} · ${decoded().width}×${decoded().height}`}
            <Show when={props.selected && props.onOpen}>
              <span style={{ fg: theme.accent }}>{"   ↵ enlarge"}</span>
            </Show>
          </text>
        </box>
      )}
    </Show>
  )
}

// Images written on one line share it (wrapping when the slots get too narrow); separate lines stack.
export function InlineImages(props: {
  itemId?: string
  lines: ChatImage[][]
  offset: number
  width: number
  selection?: string | null
  onOpen?: (id: string) => void
}) {
  return (
    <Index each={props.lines}>
      {(line, index) => {
        const start = () => props.offset + props.lines.slice(0, index).reduce((sum, earlier) => sum + earlier.length, 0)
        // The given width is a first guess; the chat's scrollbar can take a column from it.
        const [room, setRoom] = createSignal(0)
        const width = () => room() || props.width
        const perRow = () => Math.max(1, Math.min(line().length, Math.floor((width() + GAP) / (MIN_SLOT + GAP))))
        const slot = () => Math.floor((width() - GAP * (perRow() - 1)) / perRow())
        return (
          <box
            flexDirection="row"
            flexWrap="wrap"
            columnGap={GAP}
            rowGap={1}
            onSizeChange={function () {
              setRoom(this.width)
            }}
          >
            <Index each={line()}>
              {(image, n) => {
                const id = () => (props.itemId === undefined ? undefined : labelId(props.itemId, start() + n))
                const open = () => {
                  const value = id()
                  if (value) props.onOpen?.(value)
                }
                return (
                  <InlineImage
                    id={id()}
                    image={image()}
                    width={slot()}
                    selected={id() !== undefined && props.selection === id()}
                    onOpen={props.onOpen && id() ? open : undefined}
                  />
                )
              }}
            </Index>
          </box>
        )
      }}
    </Index>
  )
}
