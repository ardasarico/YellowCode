import { readFileSync } from "node:fs"
import { NativeImage, RGBA } from "@opentui/core"
import { createMemo, Index, Show } from "solid-js"
import type { ChatImage, Item } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { markdownImages } from "./markdown/images.ts"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)

// null when the file is not there; `image` is null when the bytes do not decode.
export type LoadedImage = { bytes: Uint8Array; image: NativeImage | null } | null

const loaded = new Map<string, LoadedImage>()

function read(image: ChatImage): LoadedImage {
  let bytes: Uint8Array
  try {
    if (image.data) bytes = Uint8Array.fromBase64(image.data)
    else if (image.path) bytes = readFileSync(image.path)
    else return null
  } catch {
    return null
  }
  try {
    return { bytes, image: NativeImage.decode(bytes) }
  } catch {
    return { bytes, image: null }
  }
}

export function loadImage(image: ChatImage): LoadedImage {
  const key = image.data ?? image.path ?? ""
  if (!loaded.has(key)) loaded.set(key, read(image))
  return loaded.get(key) ?? null
}

export const labelId = (itemId: string, index: number) => `${itemId}/image/${index}`

export function labelTarget(id: string): { itemId: string; index: number } | null {
  const match = /^(.+)\/image\/(\d+)$/.exec(id)
  return match ? { itemId: match[1] ?? "", index: Number(match[2]) } : null
}

export function itemImages(item: Item | undefined, cwd: string): ChatImage[] {
  if (item?.kind === "tool" || item?.kind === "user") return item.images
  if (item?.kind === "text") return markdownImages(item.markdown, cwd)
  return []
}

export function ImageLabel(props: {
  id?: string
  image: ChatImage
  prefix: string
  selected: boolean
  onOpen?: () => void
}) {
  const file = createMemo(() => loadImage(props.image))
  const size = () => {
    const decoded = file()?.image
    return decoded ? ` · ${decoded.width}×${decoded.height}` : ""
  }
  return (
    <box
      id={props.id}
      backgroundColor={(props.selected ? theme.selection : null) ?? CLEAR}
      onMouseDown={(event) => {
        if (!props.onOpen || !file()) return
        event.preventDefault()
        props.onOpen()
      }}
    >
      <Show
        when={file()}
        fallback={
          <text wrapMode="none" fg={theme.muted}>
            <span style={{ fg: theme.frame }}>{props.prefix}</span>
            {`▣ ${props.image.name} · not found`}
          </text>
        }
      >
        <text wrapMode="none">
          <span style={{ fg: theme.frame }}>{props.prefix}</span>
          <span style={{ fg: theme.accent }}>▣</span>
          <span style={{ fg: theme.text }}>{` ${props.image.name}`}</span>
          <span style={{ fg: theme.muted }}>{size()}</span>
          <Show when={props.selected && props.onOpen}>
            <span style={{ fg: theme.accent }}>{"   ↵ open"}</span>
          </Show>
        </text>
      </Show>
    </box>
  )
}

// One label line per image. `offset` numbers them after the message's earlier images.
export function ImageLabels(props: {
  itemId?: string
  images: ChatImage[]
  offset?: number
  prefix?: (index: number) => string
  selection?: string | null
  onOpen?: (id: string) => void
}) {
  return (
    <Index each={props.images}>
      {(image, index) => {
        const id = () => (props.itemId === undefined ? undefined : labelId(props.itemId, (props.offset ?? 0) + index))
        const open = () => {
          const value = id()
          if (value) props.onOpen?.(value)
        }
        return (
          <ImageLabel
            id={id()}
            image={image()}
            prefix={props.prefix?.(index) ?? ""}
            selected={id() !== undefined && props.selection === id()}
            onOpen={props.onOpen && id() ? open : undefined}
          />
        )
      }}
    </Index>
  )
}
