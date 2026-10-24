import { RGBA, type TextBufferRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import type { Token } from "marked"
import { createContext, createMemo, For, Show, useContext } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { isLocalImage } from "./images.ts"
import { mathSpans } from "./math.ts"
import { refId, textParts } from "./refs.ts"
import { proseShortcuts, shortcutKeys } from "./shortcut.ts"
import { blendsIn, swatchColor } from "./swatch.ts"

export type RunStyle = {
  fg: RGBA
  bg?: RGBA
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}
export type Run = { text: string; style: RunStyle; url?: string; ref?: string }

export type Refs = {
  itemId: string
  selection: string | null
  numbers: Map<Token, number>
  cwd: string
  images: number
  onOpen: (id: string) => void
}

type OwnRefs = Pick<Refs, "itemId" | "numbers" | "cwd" | "images">

export const RefContext = createContext<() => Refs | undefined>()

const sameRefs = (a: OwnRefs | undefined, b: OwnRefs | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.itemId === b.itemId &&
    a.cwd === b.cwd &&
    a.images === b.images &&
    a.numbers.size === b.numbers.size &&
    [...a.numbers].every(([token, number]) => b.numbers.get(token) === number))

const withoutScheme = (url: string): string => url.replace(/^[a-z]+:\/\//i, "")

const selectedStyle = (style: RunStyle) =>
  theme.selection ? { ...style, bg: theme.selection } : { ...style, reverse: true }

function hasChildren(token: Token): token is Token & { tokens: Token[] } {
  return "tokens" in token && Array.isArray(token.tokens)
}

const closesKbd = (token: Token) => token.type === "html" && /^<\/kbd>$/i.test(token.raw)

export function toRuns(
  tokens: readonly Token[],
  style: RunStyle,
  hyperlinks: boolean,
  url?: string,
  refs?: OwnRefs,
): Run[] {
  const runs: Run[] = []
  const push = (text: string, runStyle: RunStyle, runUrl = url) => {
    if (text) runs.push(runUrl ? { text, style: runStyle, url: runUrl } : { text, style: runStyle })
  }
  const nested = (token: Token, next: RunStyle, nextUrl = url) => {
    if (hasChildren(token)) runs.push(...toRuns(token.tokens, next, hyperlinks, nextUrl, refs))
    else push(token.raw, next, nextUrl)
  }
  const pushRef = (text: string, runStyle: RunStyle, id: string) => {
    if (text) runs.push({ text, style: { ...runStyle, underline: true }, ref: id })
  }
  // The id of a token's nth reference, when the token sits in a chat message.
  const refAt = (token: Token, nth = 0) => {
    const first = refs?.numbers.get(token)
    return refs && first !== undefined ? refId(refs.itemId, first + nth) : undefined
  }
  const keyCap = (key: string) =>
    push(` ${key} `, { ...style, fg: theme.text, bold: true, bg: theme.tile ?? theme.band ?? undefined })
  const keyCaps = (keys: string[]) =>
    keys.forEach((key, index) => {
      if (index > 0) push("+", { ...style, fg: theme.muted })
      keyCap(key)
    })
  const plain = (text: string, runStyle: RunStyle) => {
    for (const part of proseShortcuts(text)) {
      if (part.keys) {
        keyCaps(part.keys)
        continue
      }
      for (const span of mathSpans(part.text))
        push(span.text, span.math ? { ...runStyle, fg: theme.accent, italic: true } : runStyle)
    }
  }
  const code = (text: string, ref?: string) => {
    if (ref) return pushRef(text, { ...style, fg: theme.accent }, ref)
    const keys = shortcutKeys(text)
    if (keys) {
      keyCaps(keys)
      return
    }
    const color = swatchColor(text)
    if (color) {
      const [red, green, blue] = (style.bg ?? theme.canvas).toInts()
      // A swatch in the colour behind it would show as a blank gap, so only its outline is drawn.
      if (blendsIn(color, [red, green, blue])) push("□", { ...style, fg: theme.frame })
      else push("■", { ...style, fg: RGBA.fromInts(...color, 255) })
      push(" ", style)
    }
    push(text, { ...style, fg: theme.syntax.string })
  }
  let inKbd = false
  for (const [index, token] of tokens.entries()) {
    if (inKbd && closesKbd(token)) {
      inKbd = false
      continue
    }
    // A <kbd> nothing closes, and a </kbd> nothing opened, are shown as they were written.
    if (token.type === "html" && /^<kbd>$/i.test(token.raw) && tokens.slice(index + 1).some(closesKbd)) {
      inKbd = true
      continue
    }
    if (inKbd && (token.type === "text" || token.type === "escape")) {
      keyCap(String(token.text))
      continue
    }
    switch (token.type) {
      case "strong":
        nested(token, { ...style, bold: true })
        break
      case "em":
        nested(token, { ...style, italic: true })
        break
      case "del":
        nested(token, { ...style, strikethrough: true })
        break
      case "codespan":
        code(String(token.text), refAt(token))
        break
      case "image":
      case "link": {
        const href = String(token.href)
        // A local image is drawn under its block instead.
        if (token.type === "image" && isLocalImage(href)) break
        const ref = token.type === "link" ? refAt(token) : undefined
        if (ref) {
          pushRef(String(token.text), { ...style, fg: theme.accent }, ref)
          break
        }
        nested(token, { ...style, fg: theme.accent, underline: true }, href)
        if (!hyperlinks && token.text !== href) push(` (${withoutScheme(href)})`, { ...style, fg: theme.muted })
        break
      }
      case "br":
        push("\n", style)
        break
      case "checkbox":
        break
      case "text":
        if (hasChildren(token)) nested(token, style)
        else if (refAt(token) === undefined || !refs) plain(String(token.text), style)
        else {
          let nth = 0
          for (const part of textParts(String(token.text), refs.cwd, refs.images)) {
            if (!part.target) plain(part.text, style)
            else {
              const look = part.target.kind === "image" ? { ...style, fg: theme.accent } : style
              pushRef(part.text, look, refAt(token, nth++) ?? "")
            }
          }
        }
        break
      case "escape":
        push(String(token.text), style)
        break
      default:
        push(token.raw, style)
    }
  }
  return runs
}

export function Inline(props: { tokens: readonly Token[]; fg?: RGBA; bold?: boolean; underline?: boolean }) {
  const renderer = useRenderer()
  const context = useContext(RefContext)
  // Only this text's own reference numbers, so a delta or a selection elsewhere in the message keeps its spans.
  const refs = createMemo(
    () => {
      const value = context?.()
      if (!value) return undefined
      const numbers = new Map<Token, number>()
      const visit = (tokens: readonly Token[]) => {
        for (const token of tokens) {
          const number = value.numbers.get(token)
          if (number !== undefined) numbers.set(token, number)
          if (hasChildren(token)) visit(token.tokens)
        }
      }
      visit(props.tokens)
      return { itemId: value.itemId, numbers, cwd: value.cwd, images: value.images }
    },
    undefined,
    { equals: sameRefs },
  )
  const unselected = createMemo(() =>
    toRuns(
      props.tokens,
      { fg: props.fg ?? theme.text, bold: props.bold, underline: props.underline },
      renderer.capabilities?.hyperlinks === true,
      undefined,
      refs(),
    ),
  )
  const selection = () => context?.()?.selection
  const runs = createMemo(() => {
    const list = unselected()
    const id = selection()
    if (!id || !list.some((run) => run.ref === id)) return list
    return list.map((run) => (run.ref === id ? { text: run.text, style: selectedStyle(run.style), ref: id } : run))
  })
  // Carries the selected reference's id so the chat can scroll it into view.
  const selected = () => runs().find((run) => run.ref !== undefined && run.ref === selection())?.ref
  // The run under a click: the visual row's start column in the text plus the clicked column.
  const clicked = (text: TextBufferRenderable, x: number, y: number) => {
    const row = y - text.y
    let at = (text.lineInfo.lineStartCols[row] ?? -1) + x - text.x
    if (at < 0) return undefined
    for (const run of runs()) {
      at -= Bun.stringWidth(run.text)
      if (at < 0) return run.ref
    }
    return undefined
  }
  return (
    <Show when={runs().some((run) => run.text.trim())}>
      <text
        id={selected()}
        fg={props.fg ?? theme.text}
        onMouseDown={function (event) {
          const id = context?.() && clicked(this, event.x, event.y)
          if (!id) return
          event.preventDefault()
          context?.()?.onOpen(id)
        }}
      >
        <For each={runs()}>
          {(run) =>
            run.url ? (
              <a href={run.url} style={run.style}>
                {run.text}
              </a>
            ) : (
              <span style={run.style}>{run.text}</span>
            )
          }
        </For>
      </text>
    </Show>
  )
}
