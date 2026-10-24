import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, on, Show } from "solid-js"
import { log } from "../../log/log.ts"
import { tildePath } from "../../rewind/common.ts"
import type { ChatImage } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { cutPath } from "../format.ts"
import { createDecoded, loadImage } from "../image-label.tsx"
import { Frame } from "./frame.tsx"
import { Footer, PAD_X } from "./list-view.tsx"

const MARGIN = 0.03

let viewedDir: string | undefined

export function removeViewedImages(): void {
  if (viewedDir) rmSync(viewedDir, { recursive: true, force: true })
  viewedDir = undefined
}

// False when Preview could not open it.
async function openInPreview(image: ChatImage): Promise<boolean> {
  try {
    let path = image.path && existsSync(image.path) ? image.path : null
    if (!path && image.data) {
      const bytes = Uint8Array.fromBase64(image.data)
      viewedDir ??= mkdtempSync(join(tmpdir(), "yellowcode-viewed-"))
      path = join(viewedDir, `${Bun.hash(bytes).toString(36)}.${/^image\/(\w+)/.exec(image.mediaType)?.[1] ?? "png"}`)
      if (!existsSync(path)) await Bun.write(path, bytes)
    }
    if (!path) {
      log.warn("image not found", image.name)
      return false
    }
    const child = Bun.spawn(["open", path], { stdout: "ignore", stderr: "pipe" })
    if ((await child.exited) === 0) return true
    log.warn("open failed", await new Response(child.stderr).text())
  } catch (error) {
    log.warn("open failed", error)
  }
  return false
}

function Rule(props: { width: number }) {
  return (
    <box height={1} paddingLeft={PAD_X}>
      <text wrapMode="none" fg={theme.frame}>
        {"─".repeat(Math.max(0, props.width))}
      </text>
    </box>
  )
}

export function ImageView(props: {
  images: ChatImage[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const [notice, setNotice] = createSignal("")
  createEffect(
    on(
      () => props.index,
      () => setNotice(""),
    ),
  )
  const dimensions = useTerminalDimensions()
  const panel = () => {
    const { width, height } = dimensions()
    const gapX = Math.max(1, Math.round(width * MARGIN))
    const gapY = Math.max(1, Math.round(height * MARGIN))
    return { x: gapX, y: gapY, width: width - 2 * gapX, height: height - 2 * gapY }
  }
  const inner = () => Math.max(0, panel().width - PAD_X * 2)
  const image = () => props.images[props.index] ?? props.images[0]
  const file = () => {
    const shown = image()
    return shown ? loadImage(shown) : null
  }
  const pixels = createDecoded(image)
  const several = () => props.images.length > 1
  const details = () => {
    const loaded = file()
    if (!loaded) return " not found"
    const size = loaded.size ? `${loaded.size.width}×${loaded.size.height} · ` : ""
    return ` ${size}${Math.max(1, Math.round(loaded.bytes.length / 1024))} KB`
  }
  const counter = () => (several() ? `${props.index + 1} / ${props.images.length}  esc` : "esc")
  const actions = () => [
    ...(several() ? [{ key: "←→", action: "previous/next" }] : []),
    { key: "o", action: "open in Preview" },
    { key: "esc", action: "close" },
  ]
  const actionsWidth = () =>
    actions().reduce((sum, item, index) => sum + Bun.stringWidth(`${item.key} ${item.action}`) + (index ? 3 : 0), 0)
  const path = () => {
    const shown = image()?.path
    return shown ? cutPath(tildePath(shown), Math.max(0, inner() - actionsWidth() - 2)) : ""
  }

  useKeyboard((key) => {
    key.stopPropagation()
    key.preventDefault()
    if (key.ctrl || key.meta) return
    if (key.name === "left") props.onIndex(Math.max(0, props.index - 1))
    else if (key.name === "right") props.onIndex(Math.min(props.images.length - 1, props.index + 1))
    else if (key.name === "o") {
      const shown = image()
      if (shown) {
        setNotice("")
        void openInPreview(shown).then((opened) => {
          if (!opened) setNotice("Could not open it in Preview")
        })
      }
    } else if (key.name === "escape") props.onClose()
  })

  return (
    <Frame panel={panel()}>
      <box height={1} flexDirection="row" paddingX={PAD_X}>
        <text wrapMode="none" flexGrow={1} flexShrink={1}>
          <span style={{ fg: theme.text, bold: true }}>{image()?.name ?? ""}</span>
          <span style={{ fg: theme.panelMuted }}>{details()}</span>
        </text>
        <text wrapMode="none" flexShrink={0} fg={theme.panelMuted}>
          {counter()}
        </text>
      </box>
      <Rule width={inner()} />
      <box flexGrow={1} flexDirection="column" paddingX={PAD_X}>
        <Show when={pixels()}>{(decoded) => <image source={decoded()} fit="fit" flexGrow={1} />}</Show>
      </box>
      <Rule width={inner()} />
      <box height={1} flexDirection="row" paddingRight={PAD_X}>
        <Footer items={actions()} keys width={inner()} />
        <box flexGrow={1} />
        <text wrapMode="none" flexShrink={0} fg={notice() ? theme.panelMuted : theme.panelFaint}>
          {notice() || path()}
        </text>
      </box>
    </Frame>
  )
}
