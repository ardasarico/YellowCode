import { For, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import type { TreeRow } from "./tree.ts"

// Comments line up two cells after the widest name and wrap under themselves.
export function TreeView(props: { rows: TreeRow[] }) {
  const nameWidth = () => Math.max(...props.rows.map((row) => Bun.stringWidth(row.prefix + row.name)))
  return (
    <box flexDirection="column">
      <For each={props.rows}>
        {(row) => (
          <box flexDirection="row">
            <text wrapMode="none" flexShrink={0} width={row.comment ? nameWidth() + 2 : undefined}>
              <span style={{ fg: theme.frame }}>{row.prefix}</span>
              <span style={{ fg: theme.text, bold: row.folder }}>{row.name}</span>
            </text>
            <Show when={row.comment}>
              <text fg={theme.muted} flexGrow={1} flexShrink={1}>
                {row.comment}
              </text>
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}
