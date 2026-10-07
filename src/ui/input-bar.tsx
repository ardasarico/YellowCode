import type { KeyBinding, TextareaRenderable } from "@opentui/core"
import { theme } from "../theme/theme.ts"

const SUBMIT_ON_ENTER: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
]

export function InputBar(props: { focused: boolean; placeholder: string; onSubmit: (text: string) => void }) {
  let area: TextareaRenderable | undefined

  const submit = () => {
    if (!area) return
    props.onSubmit(area.plainText)
    area.setText("")
  }

  return (
    <box
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={props.focused ? theme.accent : theme.muted}
      paddingX={1}
    >
      <textarea
        ref={(element) => (area = element)}
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
  )
}
