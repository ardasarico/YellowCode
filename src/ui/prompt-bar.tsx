import { type TextareaRenderable, TextAttributes } from "@opentui/core"
import { Index, Show } from "solid-js"
import { settings } from "../session/settings.ts"
import type { Usage } from "../session/types.ts"
import { effortColor, yellow } from "../theme/brand.ts"
import { theme } from "../theme/theme.ts"
import { ContextRing } from "./figures.tsx"
import { formatTokens, modelName } from "./format.ts"
import { type InputBlockProps, SUBMIT_ON_ENTER } from "./input-block.tsx"
import { levelColor } from "./meters.tsx"
import type { Notice, Span } from "./notice.ts"
import { useTicker } from "./ticker.ts"
import { InputEdge, UltracodeWord } from "./ultracode.tsx"

// `spaced` keeps a blank row above an always-filled notice line (replay info) so it does not touch the chat.
// `edgeGap` adds room on the right, so the context indicator does not touch a docked sidebar.
export type PromptBarProps = InputBlockProps & {
  notice: Notice
  context: Usage["context"]
  spaced?: boolean
  edgeGap?: number
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

export function PromptBar(props: PromptBarProps) {
  let area: TextareaRenderable | undefined
  const frame = useTicker(() => settings.ultracode, 60)
  const inner = () => Math.max(0, props.width - 2 - (props.edgeGap ?? 0))

  const submit = () => {
    if (!area) return
    props.onSubmit(area.plainText)
    area.setText("")
  }

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={props.width}
      paddingLeft={1}
      paddingRight={1 + (props.edgeGap ?? 0)}
    >
      <box flexDirection="row" justifyContent="space-between" height={1} gap={2} marginTop={props.spaced ? 1 : 0}>
        <Spans spans={props.notice.left} shrink={0} />
        <Spans spans={props.notice.right} shrink={1} />
      </box>
      <InputEdge width={inner()} ultracode={settings.ultracode} frame={frame()} glyph="─" />
      <box flexDirection="row">
        <text fg={yellow(theme.rgb)} flexShrink={0}>
          {"❯ "}
        </text>
        <textarea
          ref={(element) => (area = element)}
          flexGrow={1}
          focused={props.focused}
          placeholder={props.placeholder}
          placeholderColor={theme.muted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          minHeight={1}
          maxHeight={6}
          keyBindings={SUBMIT_ON_ENTER}
          onSubmit={submit}
        />
      </box>
      <InputEdge width={inner()} ultracode={settings.ultracode} frame={frame()} glyph="─" />
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
            <UltracodeWord frame={frame()} />
          </Show>
        </box>
        <ContextIndicator context={props.context} />
      </box>
    </box>
  )
}
