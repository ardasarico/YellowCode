import { NativeImage, RGBA } from "@opentui/core"
import { Resvg } from "@resvg/resvg-js"
import { type Accessor, createMemo, createSignal, Index, onCleanup, type Setter, Show } from "solid-js"
import { shrunkCopy } from "../input/image-file.ts"
import type { ChatImage, Item } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { remember } from "./markdown/cache.ts"
import { markdownImages, readLocalImage } from "./markdown/images.ts"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)

const MAX_CACHED = 64 * 1024 * 1024
const MAX_FILES = 1000
// The long side of the copy shown for a picture too large to decode.
const SHOWN_SIDE = 4096

type Size = { width: number; height: number }
// null when the file is not there; `size` is null when the bytes do not decode, or not yet.
export type ImageFile = { bytes: Uint8Array; size: Size | null } | null

// `size` is undefined until the bytes are first decoded.
type Entry = { bytes: Uint8Array; size?: Size | null; shrinking: Accessor<boolean>; setShrinking: Setter<boolean> }

// A decoded photo takes tens of MB, so only the bytes are kept here, and pixels only while shown (`createDecoded`).
const files = new Map<string, Entry | null>()
let cached = 0
const found = new Map<string, boolean>()

function read(image: ChatImage): Uint8Array | null {
  try {
    const file = !image.data && image.path ? readLocalImage(image.path) : null
    if (image.data) return Uint8Array.fromBase64(image.data)
    if (!file) return null
    if (!image.path?.toLowerCase().endsWith(".svg")) return file
    // Loading the system fonts takes most of a second, so only an SVG with text pays for it.
    const svg = file.toString("utf8")
    return new Resvg(svg, { font: { loadSystemFonts: /<text[\s>]/.test(svg) } }).render().asPng()
  } catch {
    return null
  }
}

const keyOf = (image: ChatImage) => image.data ?? image.path ?? ""

// Past the limits the least recently used files go.
function entryOf(image: ChatImage): Entry | null {
  const key = keyOf(image)
  let entry = files.get(key)
  if (entry === undefined) {
    const bytes = read(image)
    const [shrinking, setShrinking] = createSignal(false)
    entry = bytes && { bytes, shrinking, setShrinking }
    cached += bytes?.length ?? 0
  }
  files.delete(key)
  files.set(key, entry)
  for (const [oldest, old] of files) {
    if (oldest === key || (cached <= MAX_CACHED && files.size <= MAX_FILES)) break
    files.delete(oldest)
    cached -= old?.bytes.length ?? 0
  }
  return entry
}

// A valid header can hide broken pixels, which would only fail when a frame draws them. Reading the last pixel
// decodes them all without copying them out.
export function decodeImage(bytes: Uint8Array): NativeImage | null {
  let image: NativeImage | undefined
  try {
    image = NativeImage.decode(bytes)
    image.extract({ left: image.width - 1, top: image.height - 1, width: 1, height: 1 }).dispose()
    return image
  } catch {
    image?.dispose()
    return null
  }
}

// Notes what decoding gave. A local picture the decoder refuses (over ~25 MP) is shrunk in the background and then
// shows like any other, with its own size.
function settle(image: ChatImage, entry: Entry, decoded: NativeImage | null): void {
  entry.size = decoded && { width: decoded.width, height: decoded.height }
  const path = image.data ? null : image.path
  if (decoded || !path || path.toLowerCase().endsWith(".svg")) return
  entry.size = undefined
  entry.setShrinking(true)
  void shrunkCopy(path, SHOWN_SIDE).then((copy) => {
    const pixels = copy && decodeImage(copy.bytes)
    if (copy && pixels) {
      if (files.get(keyOf(image)) === entry) cached += copy.bytes.length - entry.bytes.length
      entry.bytes = copy.bytes
      entry.size = { width: copy.width, height: copy.height }
    } else entry.size = null
    pixels?.dispose()
    entry.setShrinking(false)
  })
}

export function loadImage(image: ChatImage): ImageFile {
  const entry = entryOf(image)
  if (!entry) return null
  if (entry.size === undefined && !entry.shrinking()) {
    const decoded = decodeImage(entry.bytes)
    settle(image, entry, decoded)
    decoded?.dispose()
  }
  return { bytes: entry.bytes, size: entry.shrinking() ? null : (entry.size ?? null) }
}

// Whether the image is there to select or open; remembered, as the keyboard selection asks on every key.
export function hasImage(image: ChatImage): boolean {
  return remember(found, 5000, keyOf(image), () => entryOf(image) !== null)
}

// The image's pixels while the caller is mounted, freed with it.
export function createDecoded(image: () => ChatImage | null | undefined): () => NativeImage | undefined {
  return createMemo(() => {
    const shown = image()
    const entry = shown ? entryOf(shown) : null
    if (!shown || !entry || entry.shrinking() || entry.size === null) return undefined
    const decoded = decodeImage(entry.bytes)
    if (entry.size === undefined || !decoded) settle(shown, entry, decoded)
    if (!decoded) return undefined
    onCleanup(() => decoded.dispose())
    return decoded
  })
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
    const known = file()?.size
    return known ? ` · ${known.width}×${known.height}` : ""
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
