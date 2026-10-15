import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Show } from "solid-js"
import { log } from "../../log/log.ts"
import type { ChatImage } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { cutPath } from "../format.ts"
import { loadImage } from "../image-label.tsx"
import { Frame } from "./frame.tsx"
import { Footer, PAD_X } from "./list-view.tsx"

const MARGIN = 0.03

let opened = 0

async function openInPreview(image: ChatImage): Promise<void> {
  try {
    let path = image.path && existsSync(image.path) ? image.path : null
    if (!path && image.data) {
      path = join(tmpdir(), `yellowcode-image-${++opened}.${image.mediaType.split("/")[1] ?? "png"}`)
      await Bun.write(path, Uint8Array.fromBase64(image.data))
    }
    if (!path) return log.warn("image not found", image.name)
    const child = Bun.spawn(["open", path], { stdout: "ignore", stderr: "pipe" })
    if ((await child.exited) !== 0) log.warn("open failed", await new Response(child.stderr).text())
  } catch (error) {
    log.warn("open failed", error)
  }
}

const home = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path)

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
  const several = () => props.images.length > 1
  const details = () => {
    const loaded = file()
    if (!loaded) return " not found"
    const size = loaded.image ? `${loaded.image.width}×${loaded.image.height} · ` : ""
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
    return shown ? cutPath(home(shown), Math.max(0, inner() - actionsWidth() - 2)) : ""
  }

  useKeyboard((key) => {
    key.stopPropagation()
    key.preventDefault()
    if (key.ctrl || key.meta) return
    if (key.name === "left") props.onIndex(Math.max(0, props.index - 1))
    else if (key.name === "right") props.onIndex(Math.min(props.images.length - 1, props.index + 1))
    else if (key.name === "o") {
      const shown = image()
      if (shown) void openInPreview(shown)
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
        <Show when={file()?.image}>{(decoded) => <image source={decoded()} fit="fit" flexGrow={1} />}</Show>
      </box>
      <Rule width={inner()} />
      <box height={1} flexDirection="row" paddingRight={PAD_X}>
        <Footer items={actions()} keys width={inner()} />
        <box flexGrow={1} />
        <text wrapMode="none" flexShrink={0} fg={theme.panelFaint}>
          {path()}
        </text>
      </box>
    </Frame>
  )
}
