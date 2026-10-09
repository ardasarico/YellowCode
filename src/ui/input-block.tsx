import { type KeyBinding, type TextareaRenderable, TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { settings } from "../session/settings.ts"
import { effortColor } from "../theme/brand.ts"
import { theme } from "../theme/theme.ts"
import { modelName } from "./format.ts"
import { useTicker } from "./ticker.ts"
import { InputEdge, UltracodeWord } from "./ultracode.tsx"

export const SUBMIT_ON_ENTER: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
]

export type InputBlockProps = {
  focused: boolean
  placeholder: string
  model: string | null
  width: number
  onSubmit: (text: string) => void
}

export function InputBlock(props: InputBlockProps) {
  let area: TextareaRenderable | undefined
  const frame = useTicker(() => settings.ultracode, 60)

  const submit = () => {
    if (!area) return
    props.onSubmit(area.plainText)
    area.setText("")
  }

  return (
    <box flexDirection="column" flexShrink={0} width={props.width}>
      <box flexDirection="column" backgroundColor={theme.tile ?? undefined} paddingX={3} paddingY={1}>
        <textarea
          ref={(element) => (area = element)}
          focused={props.focused}
          placeholder={props.placeholder}
          placeholderColor={theme.muted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          backgroundColor={theme.tile ?? undefined}
          focusedBackgroundColor={theme.tile ?? undefined}
          minHeight={1}
          maxHeight={6}
          keyBindings={SUBMIT_ON_ENTER}
          onSubmit={submit}
        />
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
      <InputEdge width={props.width} ultracode={settings.ultracode} frame={frame()} />
    </box>
  )
}
