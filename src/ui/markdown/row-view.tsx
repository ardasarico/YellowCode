import { Lexer } from "marked"
import { createMemo, For, Index, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { Inline, toRuns } from "./inline.tsx"
import { packRow, ROW_RULE } from "./row.ts"

// Sections side by side, each as wide as its text, split by a rule; a row too wide for the chat wraps between sections.
export function RowView(props: { sections: string[]; width: number }) {
  const tokens = createMemo(() => props.sections.map((section) => Lexer.lexInline(section, { gfm: true })))
  const lines = createMemo(() => {
    const widths = tokens().map((one) =>
      Bun.stringWidth(
        toRuns(one, { fg: theme.text }, false)
          .map((run) => run.text)
          .join(""),
      ),
    )
    return packRow(widths, props.width)
  })
  return (
    <box flexDirection="column">
      <For each={lines()}>
        {(line) => (
          <box flexDirection="row">
            <Index each={line}>
              {(index, at) => (
                <>
                  <Show when={at > 0}>
                    <text fg={theme.frame} flexShrink={0}>
                      {ROW_RULE}
                    </text>
                  </Show>
                  <box flexShrink={0}>
                    <Inline tokens={tokens()[index()] ?? []} />
                  </box>
                </>
              )}
            </Index>
          </box>
        )}
      </For>
    </box>
  )
}
