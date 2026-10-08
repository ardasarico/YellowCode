import { infoStringToFiletype, type CodeRenderable } from "@opentui/core"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { syntaxStyle, theme } from "../../theme/theme.ts"

// One gutter row per visual line: the line number on a line's first row, blank on its wrapped rows.
export function gutterText(lineSources: readonly number[], digits: number): string {
  return lineSources
    .map((source, index) => {
      const number = index > 0 && lineSources[index - 1] === source ? "" : String(source + 1)
      return `${number.padStart(digits)} │`
    })
    .join("\n")
}

export function CodeBlock(props: { lang: string; code: string; streaming: boolean }) {
  let code: CodeRenderable | undefined
  const digits = () => String(props.code.split("\n").length).length
  const [gutter, setGutter] = createSignal("")
  const update = () => {
    if (code) setGutter(gutterText(code.lineInfo.lineSources, digits()))
  }

  onMount(() => {
    code?.on("line-info-change", update)
    update()
  })
  onCleanup(() => code?.off("line-info-change", update))

  return (
    <box flexDirection="column" paddingLeft={2}>
      <Show when={props.lang}>
        <text fg={theme.muted}>{props.lang}</text>
      </Show>
      <box flexDirection="row">
        <text fg={theme.frame} width={digits() + 3} flexShrink={0} wrapMode="none">
          {gutter()}
        </text>
        <code
          ref={(element) => (code = element)}
          content={props.code}
          filetype={infoStringToFiletype(props.lang)}
          syntaxStyle={syntaxStyle}
          streaming={props.streaming}
          fg={theme.text}
          flexGrow={1}
        />
      </box>
    </box>
  )
}
