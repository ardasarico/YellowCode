import { overridable } from "../mods/overridable.tsx"
import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createEffect, createSignal, Index, type JSX, onCleanup, onMount, Show, untrack } from "solid-js"
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
import { cut, formatTokens, modelName } from "./format.ts"
import { ImageStrip } from "./image-strip.tsx"
import { type InputBlockProps, modeWord, PROMPT_KEY_BINDINGS, UNFOLD_HINT, UnfoldHint } from "./input-block.tsx"
import { levelColor } from "./meters.tsx"
import { type NewLines, NewLinesPill } from "./new-lines-pill.tsx"
import type { Notice, Span } from "./notice.ts"
import { SuggestionList } from "./suggestion-list.tsx"
import { useTicker } from "./ticker.ts"
import { EDGE_GAP } from "./layout.ts"
import { InputEdge, UltracodeWord } from "./ultracode.tsx"

// `spaced` keeps a blank row between the chat and the prompt. The notice's right side is drawn in the top rule.
// `ask` takes the place of the rules and the input. `agents` shows the agents hint.
// `shells` draws the running-shells counter, which ↓ can select.
// `newLines` draws the pill on the row above the top rule; it covers the notice line, whose text then hides.
export type PromptBarProps = InputBlockProps & {
  notice: Notice
  context: Usage["context"]
  spaced?: boolean
  ask?: JSX.Element
  history: Accessor<Draft[]>
  onListOpen?: (open: boolean) => void
  agents?: boolean
  shells?: Shells
  newLines?: NewLines
  // What the input starts from, such as a draft the welcome screen's input held.
  draft?: Draft
}

type Shells = { count: number; selected: boolean; onOpen: () => void }

function Spans(props: { spans: Span[]; shrink: number }) {
  return (
    <text wrapMode="none" flexShrink={props.shrink}>
      <Index each={props.spans}>
        {(span) => <span style={{ fg: span().fg, bold: span().bold }}>{span().text}</span>}
      </Index>
    </text>
  )
}

const knownContext = (context: Usage["context"]) =>
  context.window !== null && context.used > 0 ? { used: context.used, window: context.window } : null

// The ring, a space and `18k/1m`.
function contextWidth(context: Usage["context"]): number {
  const known = knownContext(context)
  return known ? 2 + `${formatTokens(known.used)}/${formatTokens(known.window)}`.length : 0
}

function ContextIndicator(props: { context: Usage["context"] }) {
  const known = () => knownContext(props.context)
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

// Spans cut to `width`, the last one shown ending in `…`.
function fitSpans(spans: Span[], width: number): Span[] {
  const fitted: Span[] = []
  let left = width
  for (const span of spans) {
    if (left <= 0) break
    const text = cut(span.text, left)
    fitted.push({ ...span, text })
    left -= Bun.stringWidth(text)
  }
  return fitted
}

function NoticeLine(props: { spans: Span[]; width: number; covered: boolean }) {
  return (
    <box height={1}>
      <Spans spans={props.covered ? [] : fitSpans(props.spans, props.width)} shrink={1} />
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
    onUnfoldable: (unfoldable: boolean) => void
    hint?: string
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
    width: () => Math.max(0, props.width - 2),
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
    onEscape: () => props.onEscape?.(),
    onBackspaceEmpty: () => props.onBackspaceEmpty?.() ?? false,
    onBang: () => props.onBang?.() ?? false,
    onRecall: (to) => props.onRecall?.(to),
    fill: () => props.fill,
  })
  onMount(() => {
    completion.restore(props.draft)
    queueMicrotask(() => setArmed(true))
  })
  onCleanup(() => props.onDraft(completion.draft()))
  createEffect(() => props.onUnfoldable(completion.unfoldable()))
  onCleanup(() => props.onUnfoldable(false))

  // History wins over the hidden lines.
  const edgeLabel = () => {
    const position = completion.historyPosition()
    if (position) return `History ${position.n}/${position.m}`
    const hidden = completion.hiddenAbove()
    return hidden > 0 ? `↑ ${hidden} more ${hidden === 1 ? "line" : "lines"}` : undefined
  }

  return (
    <>
      {/* The list covers the notice line. Without the zIndex a notice line mounted after the input paints over it. */}
      <box zIndex={1}>
        <InputEdge
          width={props.width}
          ultracode={settings.ultracode}
          frame={props.frame}
          glyph="─"
          label={edgeLabel()}
          hint={props.hint}
          color={props.shell ? theme.shell : undefined}
        />
        <SuggestionList entries={completion.shown()} selected={completion.selected()} width={props.width} />
      </box>
      <ImageStrip chips={completion.chips()} marginLeft={2} onRows={setStripRows} />
      <box
        flexDirection="row"
        onSizeChange={function () {
          setInputRows(this.height)
          completion.sampleCursor()
        }}
      >
        <text fg={props.shell ? theme.shell : theme.accent} flexShrink={0}>
          {props.shell ? "! " : "❯ "}
        </text>
        <Show when={props.messageTo}>
          {(to) => (
            <text fg={theme.accent} flexShrink={0} wrapMode="none">
              {`@${to().name} `}
            </text>
          )}
        </Show>
        <textarea
          ref={completion.ref}
          flexGrow={1}
          focused={focused()}
          placeholder={props.placeholder}
          placeholderColor={theme.muted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          selectionBg={theme.selection ?? theme.frame}
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
            <text position="absolute" top={0} left={2 + hint().left} zIndex={1} fg={theme.muted}>
              {hint().text}
            </text>
          )}
        </Show>
      </box>
      <InputEdge
        width={props.width}
        ultracode={settings.ultracode}
        frame={props.frame}
        glyph="─"
        color={props.shell ? theme.shell : undefined}
      />
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

export type StatusLineProps = {
  model: string | null
  context: Usage["context"]
  frame: number
  width: number
  agents: boolean
  shells?: Shells
  asking: boolean
  unfoldable: boolean
  permissionMode?: string | null
}

function InfoLineBase(props: StatusLineProps) {
  const mode = () => modeWord(props.permissionMode ?? null)
  const modeWidth = () => (mode() ? Bun.stringWidth(mode()?.text ?? "") + 2 : 0)
  const label = () =>
    props.model ? cut(`✻ ${modelName(props.model)}`, props.width - 2 - modeWidth() - contextWidth(props.context)) : ""
  const shells = () => (props.shells && props.shells.count > 0 ? props.shells : null)
  const counterWidth = () => {
    const counter = shells()
    if (!counter) return 0
    return SHELLS_GAP.length + shellsLabel(counter.count).length + (counter.selected ? SELECTED_HINT.length : 0)
  }
  // The effort goes first when the line is too narrow, so the model name is cut only when it does not fit alone.
  const effort = () => {
    const level = settings.effort
    if (!level) return null
    const fits = Bun.stringWidth(label()) + `  effort ${level}`.length + 2 + contextWidth(props.context) <= props.width
    return fits ? level : null
  }
  const leftWidth = () =>
    modeWidth() +
    Bun.stringWidth(label()) +
    (effort() ? `  effort ${effort()}`.length : 0) +
    (settings.ultracode ? "  ultracode".length : 0) +
    counterWidth()
  const hint = () => {
    if (props.asking) return null
    const counter = shells()
    const shellsHint = counter !== null && !counter.selected
    const text = props.agents ? (shellsHint ? BOTH_HINT : AGENTS_HINT) : shellsHint ? SHELLS_HINT : null
    return text && leftWidth() + Bun.stringWidth(text) + HINT_ROOM <= props.width ? text : null
  }
  const unfold = () => {
    if (props.asking || !props.unfoldable) return false
    const shown = hint()
    const hintWidth = shown ? Bun.stringWidth(shown) + 2 : 0
    return leftWidth() + hintWidth + UNFOLD_HINT.length + HINT_ROOM <= props.width
  }
  return (
    <box flexDirection="row" justifyContent="space-between">
      <box flexDirection="row">
        <Show when={mode()}>
          {(word) => (
            <text fg={word().color} wrapMode="none">
              {`${word().text}  `}
            </text>
          )}
        </Show>
        <text fg={theme.claude} attributes={TextAttributes.BOLD} wrapMode="none">
          {label()}
        </text>
        <Show when={effort()}>
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
        <Show when={unfold()}>
          <UnfoldHint />
        </Show>
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

export function promptInnerWidth(width: number): number {
  return Math.max(0, width - 2 * EDGE_GAP)
}

function PromptBarBase(props: PromptBarProps) {
  const frame = useTicker(() => settings.ultracode, 60)
  const inner = () => promptInnerWidth(props.width)
  const hasNotice = () => props.notice.left.length > 0
  const gap = () => (props.spaced ? 1 : 0)
  const dimensions = useTerminalDimensions()
  let draft: Draft = untrack(() => props.draft) ?? { text: "", chips: [] }
  const [unfoldable, setUnfoldable] = createSignal(false)

  // The chat keeps its rows, so a tall ask scrolls inside what is left.
  const askMaxHeight = () =>
    Math.max(ASK_MIN_ROWS, dimensions().height - CHAT_MIN_ROWS - gap() - (hasNotice() ? 1 : 0) - 1)

  return (
    <box flexDirection="column" flexShrink={0} width={props.width} paddingX={EDGE_GAP}>
      <Show when={props.spaced}>
        <box height={1} flexShrink={0} />
      </Show>
      <Show when={hasNotice()}>
        <NoticeLine spans={props.notice.left} width={inner()} covered={props.newLines !== undefined} />
      </Show>
      <Show when={props.newLines}>
        {(newLines) => <NewLinesPill {...newLines()} width={props.width} top={hasNotice() ? gap() : gap() - 1} />}
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
            onDraft={(next) => {
              draft = next
              props.onDraft?.(next)
            }}
            provider={props.provider}
            history={props.history}
            onListOpen={props.onListOpen}
            onLeaveDown={props.onLeaveDown}
            onQuit={props.onQuit}
            onEscape={props.onEscape}
            messageTo={props.messageTo}
            onBackspaceEmpty={props.onBackspaceEmpty}
            shell={props.shell}
            onBang={props.onBang}
            onRecall={props.onRecall}
            fill={props.fill}
            onUnfoldable={setUnfoldable}
            hint={props.notice.right.map((span) => span.text).join("")}
          />
        }
      >
        {(ask) => (
          <box flexDirection="column" maxHeight={askMaxHeight()}>
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
        permissionMode={props.permissionMode}
        asking={props.ask !== undefined}
        unfoldable={unfoldable()}
      />
    </box>
  )
}

export const PromptBar = overridable("prompt", PromptBarBase)

const InfoLine = overridable("status-line", InfoLineBase)
