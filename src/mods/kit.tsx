// The app's parts a mod may use, so its views look like the rest of YellowCode and follow the theme.
import { type Theme, theme as current } from "../theme/theme.ts"
import { diffRows, unifiedHunks } from "../ui/diff.ts"
import { DiffView } from "../ui/diff-view.tsx"
import { CodeBlock } from "../ui/markdown/code-block.tsx"

// The current theme's colors. Read them in a view or an effect and they follow theme changes.
export const theme: Readonly<Theme> = current

// A unified diff, as `git diff` prints it, drawn like the diffs in the chat.
export function Diff(props: { diff: string; filetype?: string; context?: number }) {
  return (
    <DiffView
      rows={diffRows(unifiedHunks(props.diff), props.context ?? 3)}
      tail={false}
      expanded
      filetype={props.filetype}
    />
  )
}

// Highlighted code with line numbers; `lang` is a fence info string like "ts" or "python".
export function Code(props: { code: string; lang: string }) {
  return <CodeBlock code={props.code} lang={props.lang} streaming={false} unlabeled />
}

// A line across the given width, in the frame color.
export function Rule(props: { width: number }) {
  return (
    <text fg={current.frame} wrapMode="none">
      {"─".repeat(Math.max(0, props.width))}
    </text>
  )
}
