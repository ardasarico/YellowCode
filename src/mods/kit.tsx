// The app's parts a mod may use, so its views look like the rest of YellowCode and follow the theme.
import { infoStringToFiletype, type RGBA } from "@opentui/core"
import type { JSX } from "solid-js"
import { theme as current } from "../theme/theme.ts"
import { diffRows, unifiedHunks } from "../ui/diff.ts"
import { DiffView } from "../ui/diff-view.tsx"
import { CodeBlock } from "../ui/markdown/code-block.tsx"

// The theme colors a mod may use. Themes can reshape the rest, so only these are promised.
export type ModTheme = {
  readonly text: RGBA
  readonly muted: RGBA
  readonly faint: RGBA
  readonly accent: RGBA
  readonly success: RGBA
  readonly warning: RGBA
  readonly error: RGBA
  readonly frame: RGBA
  // Null when the theme has no selection color.
  readonly selection: RGBA | null
  readonly diffAddText: RGBA
  readonly diffDelText: RGBA
}

// The current theme's colors. Read them in a view or an effect and they follow theme changes.
export const theme: ModTheme = current

// A unified diff, as `git diff` prints it, drawn like the diffs in the chat; `lang` is a fence info string like "ts".
export function Diff(props: { diff: string; lang?: string; context?: number }): JSX.Element {
  return (
    <DiffView
      rows={diffRows(unifiedHunks(props.diff), props.context ?? 3)}
      tail={false}
      expanded
      filetype={props.lang ? infoStringToFiletype(props.lang) : undefined}
    />
  )
}

// Highlighted code with line numbers; `lang` is a fence info string like "ts" or "python".
export function Code(props: { code: string; lang: string }): JSX.Element {
  return <CodeBlock code={props.code} lang={props.lang} streaming={false} unlabeled />
}

// A line across the given width, in the frame color.
export function Rule(props: { width: number }): JSX.Element {
  return (
    <text fg={current.frame} wrapMode="none">
      {"─".repeat(Math.max(0, props.width))}
    </text>
  )
}
