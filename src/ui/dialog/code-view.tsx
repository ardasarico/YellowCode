import { readFileSync } from "node:fs"
import { extname, relative } from "node:path"
import {
  type CodeRenderable,
  infoStringToFiletype,
  type LineColorConfig,
  type LineNumberRenderable,
  type LineSign,
  type ScrollBoxRenderable,
  RGBA,
} from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { log } from "../../log/log.ts"
import { settings } from "../../session/settings.ts"
import { syntaxStyle, theme } from "../../theme/theme.ts"
import { mix } from "../color.ts"
import { cutPath } from "../format.ts"
import type { FileRef } from "../markdown/refs.ts"
import { Frame, useViewPanel } from "./frame.tsx"
import { fill, Footer, PAD_X } from "./list-view.tsx"
import { editorName, openFile } from "./open-file.ts"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)

// The panel already uses the selection tint, so the highlight is one step lighter than the panel.
const highlight = () => (theme.rgb ? mix(fill(), theme.text, 0.08) : CLEAR)

const LANGUAGES: Record<string, string> = {
  typescript: "TypeScript",
  typescriptreact: "TypeScript",
  javascript: "JavaScript",
  javascriptreact: "JavaScript",
  json: "JSON",
  markdown: "Markdown",
  python: "Python",
  rust: "Rust",
  go: "Go",
  bash: "Shell",
  css: "CSS",
  html: "HTML",
  yaml: "YAML",
  toml: "TOML",
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").replace(/\n$/, "")
  } catch (error) {
    log.warn("read failed", error)
    return null
  }
}

// `text` shows content that has no file, such as a script from a tool input; `path` then only names it.
export type CodeRef = FileRef & { text?: string }

function Rule(props: { width: number }) {
  return (
    <box height={1} paddingLeft={PAD_X} flexShrink={0}>
      <text wrapMode="none" fg={theme.frame}>
        {"─".repeat(Math.max(0, props.width))}
      </text>
    </box>
  )
}

export function CodeView(props: {
  refs: CodeRef[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
  // Copies a reference's own text (a report, a workflow script); false when the clipboard refused it.
  onCopy?: (text: string) => Promise<boolean>
}) {
  let scroll: ScrollBoxRenderable | undefined
  let code: CodeRenderable | undefined
  let numbers: LineNumberRenderable | undefined
  const [notice, setNotice] = createSignal("")
  createEffect(
    on(
      () => props.index,
      () => setNotice(""),
    ),
  )
  const panel = useViewPanel()
  const inner = () => Math.max(0, panel().width - PAD_X * 2)
  const ref = () => props.refs[props.index] ?? props.refs[0]
  const text = createMemo(() => {
    const shown = ref()
    if (!shown) return null
    return shown.text === undefined ? readText(shown.path) : shown.text.replace(/\n$/, "")
  })
  const lineCount = () => text()?.split("\n").length ?? 0
  const filetype = () => infoStringToFiletype(extname(ref()?.path ?? "").slice(1))
  const language = () => {
    const type = filetype()
    return type ? (LANGUAGES[type] ?? type.charAt(0).toUpperCase() + type.slice(1)) : ""
  }
  const name = () => {
    const path = ref()?.path ?? ""
    const local = relative(process.cwd(), path)
    return local.startsWith("..") ? path : local
  }
  const position = () => {
    const shown = ref()
    if (!shown?.line) return ""
    return shown.end ? `:${shown.line}-${shown.end}` : `:${shown.line}`
  }
  const details = () => {
    const size = text() === "" ? "empty" : `${lineCount()} ${lineCount() === 1 ? "line" : "lines"}`
    const parts = [language(), size].filter(Boolean)
    return `${position()} · ${parts.join(" · ")}`
  }
  const several = () => props.refs.length > 1
  const actions = () => [
    { key: "↑↓", action: "scroll" },
    ...(several() ? [{ key: "←→", action: "other references" }] : []),
    ...(ref()?.text === undefined
      ? [{ key: "o", action: settings.editor === "default" ? "open" : "open in editor" }]
      : props.onCopy
        ? [{ key: "c", action: "copy" }]
        : []),
    { key: "esc", action: "close" },
  ]
  const marked = createMemo(() => {
    const shown = ref()
    const colors = new Map<number, LineColorConfig>()
    const signs = new Map<number, LineSign>()
    if (shown?.line) {
      const last = Math.min(shown.end ?? shown.line, lineCount())
      for (let line = shown.line; line <= last; line++)
        colors.set(line - 1, { gutter: highlight(), content: highlight() })
      signs.set(shown.line - 1, { before: "▸ ", beforeColor: theme.accent })
    }
    return { colors, signs }
  })
  createEffect(() => {
    numbers?.setLineColors(marked().colors)
    numbers?.setLineSigns(marked().signs)
  })
  createEffect(() => {
    if (numbers) numbers.showLineNumbers = Boolean(text())
  })

  // Puts the target line about a third down the panel once the wrapped rows are known.
  const scrollToTarget = () => {
    const line = ref()?.line
    if (!scroll || !code) return
    if (!line) return scroll.scrollTo(0)
    const row = code.lineInfo.lineSources.indexOf(line - 1)
    scroll.scrollTo(Math.max(0, row - Math.floor(scroll.viewport.height / 3)))
  }
  createEffect(
    on(
      () => [props.index, text()] as const,
      ([, content], previous) => {
        if (!code) return
        // Another reference in the same file keeps the wrapped rows, so no new ones are coming.
        if (previous && previous[1] === content) return scrollToTarget()
        code.once("line-info-change", scrollToTarget)
        onCleanup(() => code?.off("line-info-change", scrollToTarget))
      },
    ),
  )

  useKeyboard((key) => {
    key.stopPropagation()
    key.preventDefault()
    if (key.ctrl || key.meta) return
    const page = Math.max(1, (scroll?.viewport.height ?? 1) - 1)
    if (key.name === "up") scroll?.scrollBy(-1)
    else if (key.name === "down") scroll?.scrollBy(1)
    else if (key.name === "pageup") scroll?.scrollBy(-page)
    else if (key.name === "pagedown") scroll?.scrollBy(page)
    else if (key.name === "left") props.onIndex(Math.max(0, props.index - 1))
    else if (key.name === "right") props.onIndex(Math.min(props.refs.length - 1, props.index + 1))
    else if (key.name === "o") {
      const shown = ref()
      if (shown && shown.text === undefined) {
        setNotice("")
        void openFile(shown.path, shown.line).then((inEditor) => {
          if (!inEditor) setNotice(`${editorName(settings.editor)} could not open it`)
        })
      }
    } else if (key.name === "c") {
      const own = ref()?.text
      if (own !== undefined && props.onCopy) {
        setNotice("")
        void props.onCopy(own).then((copied) => setNotice(copied ? "Copied" : "Could not copy it"))
      }
    } else if (key.name === "escape") props.onClose()
  })

  return (
    <Frame panel={panel()}>
      <box height={1} flexDirection="row" paddingX={PAD_X} flexShrink={0}>
        <text wrapMode="none" flexGrow={1} flexShrink={1}>
          <span style={{ fg: theme.text, bold: true }}>{cutPath(name(), Math.max(10, inner() - 40))}</span>
          <span style={{ fg: theme.panelMuted }}>{text() === null ? " · cannot be read" : details()}</span>
        </text>
        <text wrapMode="none" flexShrink={0} fg={theme.panelMuted}>
          esc
        </text>
      </box>
      <Rule width={inner()} />
      <scrollbox ref={(element) => (scroll = element)} flexGrow={1} paddingX={PAD_X}>
        <line_number
          ref={(element: LineNumberRenderable) => (numbers = element)}
          fg={theme.panelFaint}
          minWidth={String(lineCount()).length + 2}
          paddingRight={2}
        >
          <code
            ref={(element) => (code = element)}
            content={text() ?? ""}
            filetype={filetype()}
            conceal={false}
            syntaxStyle={syntaxStyle()}
            fg={theme.text}
            wrapMode="word"
            flexGrow={1}
          />
        </line_number>
      </scrollbox>
      <Rule width={inner()} />
      <box height={1} flexDirection="row" paddingRight={PAD_X} flexShrink={0}>
        <Footer items={actions()} keys width={inner()} />
        <box flexGrow={1} />
        <text wrapMode="none" flexShrink={0} fg={theme.panelMuted}>
          {notice() || (several() ? `${props.index + 1} / ${props.refs.length}` : "")}
        </text>
      </box>
    </Frame>
  )
}
