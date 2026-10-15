import type { RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import type { Token } from "marked"
import { createMemo, For, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { isLocalImage } from "./images.ts"

export type RunStyle = { fg: RGBA; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean }
export type Run = { text: string; style: RunStyle; url?: string }

const withoutScheme = (url: string): string => url.replace(/^[a-z]+:\/\//i, "")

function hasChildren(token: Token): token is Token & { tokens: Token[] } {
  return "tokens" in token && Array.isArray(token.tokens)
}

export function toRuns(tokens: readonly Token[], style: RunStyle, hyperlinks: boolean, url?: string): Run[] {
  const runs: Run[] = []
  const push = (text: string, runStyle: RunStyle, runUrl = url) => {
    if (text) runs.push(runUrl ? { text, style: runStyle, url: runUrl } : { text, style: runStyle })
  }
  const nested = (token: Token, next: RunStyle, nextUrl = url) => {
    if (hasChildren(token)) runs.push(...toRuns(token.tokens, next, hyperlinks, nextUrl))
    else push(token.raw, next, nextUrl)
  }
  for (const token of tokens) {
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
        push(String(token.text), { ...style, fg: theme.accent })
        break
      case "image":
      case "link": {
        const href = String(token.href)
        // A local image is drawn under its block instead.
        if (token.type === "image" && isLocalImage(href)) break
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
      case "escape":
        if (hasChildren(token)) nested(token, style)
        else push(String(token.text), style)
        break
      default:
        push(token.raw, style)
    }
  }
  return runs
}

export function Inline(props: { tokens: readonly Token[]; fg?: RGBA; bold?: boolean }) {
  const renderer = useRenderer()
  const runs = createMemo(() =>
    toRuns(props.tokens, { fg: props.fg ?? theme.text, bold: props.bold }, renderer.capabilities?.hyperlinks === true),
  )
  return (
    <Show when={runs().some((run) => run.text.trim())}>
      <text fg={props.fg ?? theme.text}>
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
