import { type BoxRenderable, type KeyBinding, type RGBA, TextAttributes } from "@opentui/core"
import { type Accessor, onCleanup, onMount, Show } from "solid-js"
import { readClipboard } from "../input/clipboard.ts"
import { loadImage } from "../input/image-file.ts"
import type { Draft } from "../input/draft.ts"
import type { InputProvider } from "../input/provider.ts"
import { modeLabel } from "../session/settings-file.ts"
import { settings } from "../session/settings.ts"
import { effortColor } from "../theme/brand.ts"
import { syntaxStyle, theme } from "../theme/theme.ts"
import { type Submission, useCompletion } from "./completion.ts"
import { cut, modelName } from "./format.ts"
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
  onSubmit: (submission: Submission) => boolean
  onLeaveDown?: () => void
  onQuit?: () => void
  onEscape?: () => void
  // The agent the prompt writes to: its label and the keys that leave or restore the mode.
  messageTo?: { id: string; name: string } | null
  onBackspaceEmpty?: () => boolean
  // `!` shell mode, and the call that turns it on when `!` starts an empty prompt (true when it did).
  shell?: boolean
  onBang?: () => boolean
  onRecall?: (to: { id: string; name: string } | null) => void
  fill?: { draft: Draft; seq: number; ifEmpty?: boolean; insert?: boolean }
  // Gets what the input still holds when it goes away.
  onDraft?: (draft: Draft) => void
  // What the input starts from, such as what the prompt bar held when a /clear brought the welcome screen back.
  draft?: Draft
  // Earlier messages, for ↑ and ↓ on an empty input.
  history?: Accessor<Draft[]>
  // The running session's permission mode; auto shows nothing.
  permissionMode?: string | null
}

export function modeWord(mode: string | null): { text: string; color: RGBA } | null {
  if (mode === null || mode === "auto") return null
  if (mode === "acceptEdits") return { text: "⏵⏵ accept edits", color: theme.shell }
  if (mode === "plan") return { text: "⏸ plan", color: theme.accent }
  return { text: modeLabel(mode), color: theme.warning }
}

export const TILE_PADDING = 3

export const UNFOLD_HINT = "ctrl+x unfold"

export function UnfoldHint() {
  return (
    <text wrapMode="none">
      <span style={{ fg: theme.text }}>{"ctrl+x"}</span>
      <span style={{ fg: theme.muted }}>{" unfold"}</span>
    </text>
  )
}

const rightWidth = () =>
  (settings.effort ? `  effort ${settings.effort}`.length : 0) + (settings.ultracode ? "  ultracode".length : 0)

// The suggestion list opens above the tile, over whatever the welcome screen shows there, and its padding rows are
// taken from the room.
export function InputBlock(props: InputBlockProps) {
  let block: BoxRenderable | undefined
  const frame = useTicker(() => settings.ultracode, 60)
  const completion = useCompletion({
    focused: () => props.focused,
    provider: () => props.provider,
    width: () => Math.max(0, props.width - 2 * TILE_PADDING),
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
    history: () => props.history?.() ?? [],
  })
  onMount(() => {
    if (props.draft) completion.restore(props.draft)
  })
  onCleanup(() => props.onDraft?.(completion.draft()))
  const modelLabel = () => {
    if (!props.model) return ""
    return cut(`✻ ${modelName(props.model)}`, props.width - 2 * TILE_PADDING - rightWidth())
  }
  const unfold = () =>
    completion.unfoldable() &&
    Bun.stringWidth(modelLabel()) + 2 + UNFOLD_HINT.length + rightWidth() <= props.width - 2 * TILE_PADDING

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
              // The themes' selection colour is their tile colour, so a selection on the tile takes the frame colour.
              selectionBg={theme.frame}
              selectionFg={theme.text}
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
            <box flexDirection="row">
              <Show when={modeWord(props.permissionMode ?? null)}>
                {(word) => (
                  <text fg={word().color} wrapMode="none">
                    {`${word().text}  `}
                  </text>
                )}
              </Show>
              <text fg={theme.claude} attributes={TextAttributes.BOLD} wrapMode="none">
                {modelLabel()}
              </text>
            </box>
            <box flexDirection="row">
              <Show when={unfold()}>
                <UnfoldHint />
                <text>{settings.effort ? "  " : ""}</text>
              </Show>
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
