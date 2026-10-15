import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createSignal, Index, type JSX, onCleanup, onMount, Show } from "solid-js"
import { readClipboard } from "../input/clipboard.ts"
import type { Draft } from "../input/draft.ts"
import { loadImage } from "../input/image-file.ts"
import type { InputProvider } from "../input/provider.ts"
import { settings } from "../session/settings.ts"
import type { Usage } from "../session/types.ts"
import { effortColor } from "../theme/brand.ts"
import { syntaxStyle, theme } from "../theme/theme.ts"
import { useCompletion } from "./completion.ts"
import { ContextRing } from "./figures.tsx"
import { formatTokens, modelName } from "./format.ts"
import { ImageStrip } from "./image-strip.tsx"
import { type InputBlockProps, PROMPT_KEY_BINDINGS } from "./input-block.tsx"
import { levelColor } from "./meters.tsx"
import type { Notice, Span } from "./notice.ts"
import { SuggestionList } from "./suggestion-list.tsx"
import { useTicker } from "./ticker.ts"
import { InputEdge, UltracodeWord } from "./ultracode.tsx"

// `spaced` keeps a blank row above an always-filled notice line (replay info) so it does not touch the chat.
// `edgeGap` adds room on the right, so the context indicator does not touch a docked sidebar.
// `ask` takes the place of the rules and the input. `agents` shows the agents hint.
// `shells` draws the running-shells counter, which ↓ can select.
export type PromptBarProps = InputBlockProps & {
  notice: Notice
  context: Usage["context"]
  spaced?: boolean
  edgeGap?: number
  ask?: JSX.Element
  history: Accessor<Draft[]>
  onListOpen?: (open: boolean) => void
  agents?: boolean
  shells?: Shells
}

type Shells = { count: number; selected: boolean; onOpen: () => void }

function Spans(props: { spans: Span[]; shrink: number }) {
  return (
    <text wrapMode="none" flexShrink={props.shrink}>
      <Index each={props.spans}>{(span) => <span style={{ fg: span().fg }}>{span().text}</span>}</Index>
    </text>
  )
}

function ContextIndicator(props: { context: Usage["context"] }) {
  const known = () => {
    const window = props.context.window
    return window !== null && props.context.used > 0 ? { used: props.context.used, window } : null
  }
  return (
    <Show when={known()}>
      {(context) => {
        const fraction = () => context().used / context().window
        return (
          <box flexDirection="row" flexShrink={0}>
            <ContextRing fraction={fraction()} color={levelColor(fraction())} background={theme.background} />
            <text wrapMode="none">
              <span style={{ fg: levelColor(fraction()) }}>{` ${formatTokens(context().used)}`}</span>
              <span style={{ fg: theme.muted }}>{`/${formatTokens(context().window)}`}</span>
            </text>
          </box>
        )
      }}
    </Show>
  )
}

function NoticeLine(props: { notice: Notice; spaced?: boolean }) {
  return (
    <box flexDirection="row" justifyContent="space-between" height={1} gap={2} marginTop={props.spaced ? 1 : 0}>
      <Spans spans={props.notice.left} shrink={0} />
      <Spans spans={props.notice.right} shrink={1} />
    </box>
  )
}

// An ask unmounts the input, so the draft is handed back on cleanup and restored when the input returns.
function PromptInput(
  props: Omit<InputBlockProps, "model"> & {
    frame: number
    draft: Draft
    onDraft: (draft: Draft) => void
    provider: InputProvider
    history: Accessor<Draft[]>
    onListOpen?: (open: boolean) => void
    onLeaveDown?: () => void
  },
) {
  const dimensions = useTerminalDimensions()
  const [inputRows, setInputRows] = createSignal(1)
  const [stripRows, setStripRows] = createSignal(0)
  // The key that closes an ask is still being dispatched when the input mounts; it must not reach the textarea.
  const [armed, setArmed] = createSignal(false)
  const focused = () => props.focused && armed()
  const completion = useCompletion({
    focused,
    provider: () => props.provider,
    width: () => props.width - 2,
    room: () =>
      dimensions().height -
      3 -
      inputRows() -
      (completion.chips().some(({ chip }) => chip.kind === "image") ? stripRows() : 0),
    onSubmit: (submission) => props.onSubmit(submission),
    readClipboard,
    loadImage,
    history: () => props.history(),
    onListOpen: (open) => props.onListOpen?.(open),
    onLeaveDown: () => props.onLeaveDown?.(),
    onQuit: () => props.onQuit?.(),
    fill: () => props.fill,
  })
  onMount(() => {
    completion.restore(props.draft)
    queueMicrotask(() => setArmed(true))
  })
  onCleanup(() => props.onDraft(completion.draft()))

  return (
    <>
      <box>
        <InputEdge width={props.width} ultracode={settings.ultracode} frame={props.frame} glyph="─" />
        <SuggestionList entries={completion.shown()} selected={completion.selected()} width={props.width} />
      </box>
      <ImageStrip chips={completion.chips()} marginLeft={2} onRows={setStripRows} />
      <box
        flexDirection="row"
        onSizeChange={function () {
          setInputRows(this.height)
        }}
      >
        <text fg={theme.accent} flexShrink={0}>
          {"❯ "}
        </text>
        <textarea
          ref={completion.ref}
          flexGrow={1}
          focused={focused()}
          placeholder={props.placeholder}
          placeholderColor={theme.muted}
          textColor={theme.text}
          focusedTextColor={theme.text}
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
            <text position="absolute" top={0} left={2 + hint().left} zIndex={1} fg={theme.muted}>
              {hint().text}
            </text>
          )}
        </Show>
      </box>
      <InputEdge width={props.width} ultracode={settings.ultracode} frame={props.frame} glyph="─" />
    </>
  )
}

const AGENTS_HINT = "↓ agents"
const SHELLS_HINT = "↓ shells"
const BOTH_HINT = "↓ shells · agents"
const SHELLS_GAP = "   "
const SELECTED_HINT = " · enter view shells"
// The hint's gap and the widest context indicator.
const HINT_ROOM = 18

function shellsLabel(count: number): string {
  return count === 1 ? "1 shell" : `${count} shells`
}

function InfoLine(props: {
  model: string | null
  context: Usage["context"]
  frame: number
  width: number
  agents: boolean
  shells?: Shells
}) {
  const label = () => (props.model ? `✻ ${modelName(props.model)}` : "")
  const shells = () => (props.shells && props.shells.count > 0 ? props.shells : null)
  const counterWidth = () => {
    const counter = shells()
    if (!counter) return 0
    return SHELLS_GAP.length + shellsLabel(counter.count).length + (counter.selected ? SELECTED_HINT.length : 0)
  }
  const leftWidth = () =>
    Bun.stringWidth(label()) +
    (settings.effort ? `  effort ${settings.effort}`.length : 0) +
    (settings.ultracode ? "  ultracode".length : 0) +
    counterWidth()
  const hint = () => {
    const counter = shells()
    const shellsHint = counter !== null && !counter.selected
    const text = props.agents ? (shellsHint ? BOTH_HINT : AGENTS_HINT) : shellsHint ? SHELLS_HINT : null
    return text && leftWidth() + Bun.stringWidth(text) + HINT_ROOM <= props.width ? text : null
  }
  return (
    <box flexDirection="row" justifyContent="space-between">
      <box flexDirection="row">
        <text fg={theme.claude} attributes={TextAttributes.BOLD}>
          {label()}
        </text>
        <Show when={settings.effort}>
          {(level) => (
            <text>
              <span style={{ fg: theme.muted }}>{"  effort "}</span>
              <span style={{ fg: effortColor(level(), theme.rgb) }}>{level()}</span>
            </text>
          )}
        </Show>
        <Show when={settings.ultracode}>
          <text>{"  "}</text>
          <UltracodeWord frame={props.frame} />
        </Show>
        <Show when={shells()}>
          {(counter) => (
            <box flexDirection="row" onMouseDown={() => counter().onOpen()}>
              <text wrapMode="none">{SHELLS_GAP}</text>
              <text
                wrapMode="none"
                fg={counter().selected ? (theme.background ?? RGBA.fromIndex(0)) : theme.success}
                bg={counter().selected ? theme.success : undefined}
              >
                {shellsLabel(counter().count)}
              </text>
              <Show when={counter().selected}>
                <text wrapMode="none">
                  <span style={{ fg: theme.faint }}>{" · "}</span>
                  <span style={{ fg: theme.text }}>{"enter"}</span>
                  <span style={{ fg: theme.muted }}>{" view shells"}</span>
                </text>
              </Show>
            </box>
          )}
        </Show>
      </box>
      <box flexDirection="row" gap={2}>
        <Show when={hint()}>
          {(text) => (
            <text fg={theme.muted} wrapMode="none">
              {text()}
            </text>
          )}
        </Show>
        <ContextIndicator context={props.context} />
      </box>
    </box>
  )
}

const CHAT_MIN_ROWS = 6
const ASK_MIN_ROWS = 7

export function promptInnerWidth(width: number, edgeGap: number): number {
  return Math.max(0, width - 2 - edgeGap)
}

export function PromptBar(props: PromptBarProps) {
  const frame = useTicker(() => settings.ultracode, 60)
  const inner = () => promptInnerWidth(props.width, props.edgeGap ?? 0)
  const hasNotice = () => props.notice.left.length > 0 || props.notice.right.length > 0
  const dimensions = useTerminalDimensions()
  let draft: Draft = { text: "", chips: [] }

  // The chat keeps its rows, so a tall ask scrolls inside what is left.
  const askGap = () => (props.spaced && !hasNotice() ? 1 : 0)
  const askMaxHeight = () => {
    const notice = hasNotice() ? 1 + (props.spaced ? 1 : 0) : 0
    return Math.max(ASK_MIN_ROWS, dimensions().height - CHAT_MIN_ROWS - notice - askGap() - 1)
  }

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={props.width}
      paddingLeft={1}
      paddingRight={1 + (props.edgeGap ?? 0)}
    >
      <Show when={hasNotice()}>
        <NoticeLine notice={props.notice} spaced={props.spaced} />
      </Show>
      <Show
        when={props.ask}
        keyed
        fallback={
          <PromptInput
            focused={props.focused}
            placeholder={props.placeholder}
            width={inner()}
            onSubmit={props.onSubmit}
            frame={frame()}
            draft={draft}
            onDraft={(next) => (draft = next)}
            provider={props.provider}
            history={props.history}
            onListOpen={props.onListOpen}
            onLeaveDown={props.onLeaveDown}
            onQuit={props.onQuit}
            fill={props.fill}
          />
        }
      >
        {(ask) => (
          <box flexDirection="column" marginTop={askGap()} maxHeight={askMaxHeight()}>
            {ask}
          </box>
        )}
      </Show>
      <InfoLine
        model={props.model}
        context={props.context}
        frame={frame()}
        width={inner()}
        agents={props.agents ?? false}
        shells={props.shells}
      />
    </box>
  )
}
