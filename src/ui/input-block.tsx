import { type BoxRenderable, type KeyBinding, TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { readClipboard } from "../input/clipboard.ts"
import { loadImage } from "../input/image-file.ts"
import type { Draft } from "../input/draft.ts"
import type { InputProvider } from "../input/provider.ts"
import { settings } from "../session/settings.ts"
import { effortColor } from "../theme/brand.ts"
import { syntaxStyle, theme } from "../theme/theme.ts"
import { type Submission, useCompletion } from "./completion.ts"
import { modelName } from "./format.ts"
import { ImageStrip } from "./image-strip.tsx"
import { filledPadding, SuggestionList } from "./suggestion-list.tsx"
import { useTicker } from "./ticker.ts"
import { InputEdge, UltracodeWord } from "./ultracode.tsx"

export const PROMPT_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "_", ctrl: true, action: "undo" },
  { name: "z", ctrl: true, action: "undo" },
  { name: "z", ctrl: true, shift: true, action: "redo" },
]

export type InputBlockProps = {
  focused: boolean
  placeholder: string
  model: string | null
  width: number
  provider: InputProvider
  onSubmit: (submission: Submission) => void
  onLeaveDown?: () => void
  onQuit?: () => void
  onEscape?: () => void
  fill?: { draft: Draft; seq: number }
}

export const TILE_PADDING = 3

// The suggestion list opens above the tile, over whatever the welcome screen shows there, and its padding rows are
// taken from the room.
export function InputBlock(props: InputBlockProps) {
  let block: BoxRenderable | undefined
  const frame = useTicker(() => settings.ultracode, 60)
  const completion = useCompletion({
    focused: () => props.focused,
    provider: () => props.provider,
    width: () => props.width - 2 * TILE_PADDING,
    room: () => {
      const padding = filledPadding()
      return Math.max(0, (block?.y ?? 0) - padding.top - padding.bottom)
    },
    onSubmit: (submission) => props.onSubmit(submission),
    readClipboard,
    loadImage,
    onLeaveDown: () => props.onLeaveDown?.(),
    onQuit: () => props.onQuit?.(),
    fill: () => props.fill,
  })

  return (
    <box ref={(element) => (block = element)} flexDirection="column" flexShrink={0} width={props.width}>
      <SuggestionList
        entries={completion.shown()}
        selected={completion.selected()}
        width={props.width}
        indent={TILE_PADDING}
        filled
      />
      <box flexDirection="column" backgroundColor={theme.tile ?? undefined}>
        <box height={1} flexShrink={0} />
        <box flexDirection="column" paddingX={TILE_PADDING} paddingBottom={1}>
          <ImageStrip chips={completion.chips()} />
          <box flexDirection="row">
            <textarea
              ref={completion.ref}
              flexGrow={1}
              focused={props.focused}
              placeholder={props.placeholder}
              placeholderColor={theme.muted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              backgroundColor={theme.tile ?? undefined}
              focusedBackgroundColor={theme.tile ?? undefined}
              syntaxStyle={syntaxStyle()}
              minHeight={1}
              maxHeight={6}
              keyBindings={PROMPT_KEY_BINDINGS}
              onSubmit={completion.submit}
              onPaste={completion.paste}
              onContentChange={completion.refresh}
              onCursorChange={completion.leftToken}
            />
            <Show when={completion.hint()}>
              {(hint) => (
                <text position="absolute" top={0} left={hint().left} zIndex={1} fg={theme.muted}>
                  {hint().text}
                </text>
              )}
            </Show>
          </box>
          <box height={1} />
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.claude} attributes={TextAttributes.BOLD}>
              {props.model ? `✻ ${modelName(props.model)}` : ""}
            </text>
            <box flexDirection="row">
              <Show when={settings.effort}>
                {(level) => (
                  <text>
                    <span style={{ fg: theme.muted }}>effort </span>
                    <span style={{ fg: effortColor(level(), theme.rgb) }}>{level()}</span>
                  </text>
                )}
              </Show>
              <Show when={settings.ultracode}>
                <text>{"  "}</text>
                <UltracodeWord frame={frame()} />
              </Show>
            </box>
          </box>
        </box>
      </box>
      <InputEdge width={props.width} ultracode={settings.ultracode} frame={frame()} />
    </box>
  )
}
