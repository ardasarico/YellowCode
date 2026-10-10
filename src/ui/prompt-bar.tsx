import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createSignal, Index, type JSX, onCleanup, onMount, Show } from "solid-js"
import type { InputProvider } from "../input/provider.ts"
import { settings } from "../session/settings.ts"
import type { Usage } from "../session/types.ts"
import { effortColor } from "../theme/brand.ts"
import { syntaxStyle, theme } from "../theme/theme.ts"
import { useCompletion } from "./completion.ts"
import { ContextRing } from "./figures.tsx"
import { formatTokens, modelName } from "./format.ts"
import { type InputBlockProps, PROMPT_KEY_BINDINGS } from "./input-block.tsx"
import { levelColor } from "./meters.tsx"
import type { Notice, Span } from "./notice.ts"
import { SuggestionList } from "./suggestion-list.tsx"
import { useTicker } from "./ticker.ts"
import { InputEdge, UltracodeWord } from "./ultracode.tsx"

// `spaced` keeps a blank row above an always-filled notice line (replay info) so it does not touch the chat.
// `edgeGap` adds room on the right, so the context indicator does not touch a docked sidebar.
// `ask` takes the place of the rules and the input.
export type PromptBarProps = InputBlockProps & {
  notice: Notice
  context: Usage["context"]
  spaced?: boolean
  edgeGap?: number
  ask?: JSX.Element
  history: Accessor<string[]>
  onListOpen?: (open: boolean) => void
}

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
    draft: string
    onDraft: (text: string) => void
    provider: InputProvider
    history: Accessor<string[]>
    onListOpen?: (open: boolean) => void
  },
) {
  const dimensions = useTerminalDimensions()
  const [inputRows, setInputRows] = createSignal(1)
  const completion = useCompletion({
    focused: () => props.focused,
    provider: () => props.provider,
    width: () => props.width - 2,
    room: () => dimensions().height - 3 - inputRows(),
    onSubmit: (text) => props.onSubmit(text),
    history: () => props.history(),
    onListOpen: (open) => props.onListOpen?.(open),
  })
  onMount(() => completion.restore(props.draft))
  onCleanup(() => props.onDraft(completion.text()))

  return (
    <>
      <box>
        <InputEdge width={props.width} ultracode={settings.ultracode} frame={props.frame} glyph="─" />
        <SuggestionList entries={completion.shown()} selected={completion.selected()} width={props.width} />
      </box>
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
          focused={props.focused}
          placeholder={props.placeholder}
          placeholderColor={theme.muted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          syntaxStyle={syntaxStyle()}
          minHeight={1}
          maxHeight={6}
          keyBindings={PROMPT_KEY_BINDINGS}
          onSubmit={completion.submit}
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

function InfoLine(props: { model: string | null; context: Usage["context"]; frame: number }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <box flexDirection="row">
        <text fg={theme.claude} attributes={TextAttributes.BOLD}>
          {props.model ? `✻ ${modelName(props.model)}` : ""}
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
      </box>
      <ContextIndicator context={props.context} />
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
  let draft = ""

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
            onDraft={(text) => (draft = text)}
            provider={props.provider}
            history={props.history}
            onListOpen={props.onListOpen}
          />
        }
      >
        {(ask) => (
          <box flexDirection="column" marginTop={askGap()} maxHeight={askMaxHeight()}>
            {ask}
          </box>
        )}
      </Show>
      <InfoLine model={props.model} context={props.context} frame={frame()} />
    </box>
  )
}
