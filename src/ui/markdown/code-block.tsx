import { infoStringToFiletype, StyledText, type CodeRenderable, type SyntaxStyle, type TextChunk } from "@opentui/core"
import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { syntaxStyle, theme } from "../../theme/theme.ts"

// One gutter row per visual line: the line number on a line's first row, blank on its wrapped rows.
function gutterText(lineSources: readonly number[], digits: number): string {
  return lineSources
    .map((source, index) => {
      const number = index > 0 && lineSources[index - 1] === source ? "" : String(source + 1)
      return `${number.padStart(digits)} │`
    })
    .join("\n")
}

function commonPrefix(a: string, b: string): number {
  let length = 0
  while (length < a.length && a[length] === b[length]) length += 1
  return length
}

function splitChunks(chunks: readonly TextChunk[], at: number): [TextChunk[], TextChunk[]] {
  const before: TextChunk[] = []
  const after: TextChunk[] = []
  let start = 0
  for (const chunk of chunks) {
    const cut = Math.max(0, Math.min(chunk.text.length, at - start))
    if (cut > 0) before.push(cut === chunk.text.length ? chunk : { ...chunk, text: chunk.text.slice(0, cut) })
    if (cut < chunk.text.length) after.push(cut === 0 ? chunk : { ...chunk, text: chunk.text.slice(cut) })
    start += chunk.text.length
  }
  return [before, after]
}

export function CodeBlock(props: {
  lang: string
  code: string
  streaming: boolean
  bare?: boolean
  unlabeled?: boolean
}) {
  let code: CodeRenderable | undefined
  let highlighted: { content: string; chunks: TextChunk[]; style: SyntaxStyle } | undefined
  const initialCode = untrack(() => props.code)
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

  // Setting `content` redraws the whole block unstyled, or not at all, until tree-sitter catches up, so lines flash or
  // the text below jumps. Instead keep the last highlight's colors on the unchanged start and draw the rest plain.
  createEffect(
    on(
      () => props.code,
      (content) => {
        if (!code || content === code.content) return
        const kept = highlighted ? commonPrefix(highlighted.content, content) : 0
        const rest: TextChunk = { __isChunk: true, text: content.slice(kept) }
        const old = highlighted ? splitChunks(highlighted.chunks, kept)[0] : []
        code.updateStreamingPreview(content, new StyledText([...old, rest]))
      },
      { defer: true },
    ),
  )

  return (
    <box flexDirection="column" paddingLeft={2}>
      <Show when={props.lang && !props.bare && !props.unlabeled}>
        <text fg={theme.muted}>{props.lang}</text>
      </Show>
      <box flexDirection="row">
        <Show when={!props.bare}>
          <text fg={theme.frame} width={digits() + 3} flexShrink={0} wrapMode="none">
            {gutter()}
          </text>
        </Show>
        <code
          ref={(element) => (code = element)}
          content={initialCode}
          filetype={infoStringToFiletype(props.lang)}
          syntaxStyle={syntaxStyle()}
          // Unfinished code parses with errors that recolor earlier lines back and forth, so while the block is written
          // its finished lines keep their first colors. The final highlight once the block is done colors everything.
          onChunks={(chunks, context) => {
            const previous = highlighted?.style === context.syntaxStyle ? highlighted : undefined
            const settled =
              props.streaming && previous
                ? Math.min(commonPrefix(previous.content, context.content), previous.content.lastIndexOf("\n") + 1)
                : 0
            const merged = [...splitChunks(previous?.chunks ?? [], settled)[0], ...splitChunks(chunks, settled)[1]]
            highlighted = { content: context.content, chunks: merged, style: context.syntaxStyle }
            return merged
          }}
          // Always streaming, so a re-highlight keeps the old colored text. Only the block still being written may
          // draw unstyled text first; a finished block keeps its colors through a theme switch.
          streaming
          drawUnstyledText={props.streaming}
          fg={theme.text}
          flexGrow={1}
        />
      </box>
    </box>
  )
}
