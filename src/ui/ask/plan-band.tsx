import { type InputRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createSignal, Index, Show } from "solid-js"
import { z } from "zod"
import { allowTool, DECLINED_WITH_NOTE, denyTool, TOOL_DECLINED } from "../../protocol/outgoing.ts"
import { theme } from "../../theme/theme.ts"
import { covered } from "../images.ts"
import { Markdown } from "../markdown/markdown.tsx"
import { barChars } from "../user-message.tsx"
import { AskScroll } from "./ask-scroll.tsx"
import type { AskViewProps } from "./ask-surface.tsx"
import { fitHints } from "./fit.ts"
import { typingGuard } from "./typing.ts"

const CHOICES = ["Yes, start", "Keep planning"]
const HINTS = "↑↓ choose · enter confirm · esc keep planning"
const SCROLL_HINTS = "scroll for more · ↑↓ choose · enter confirm · esc keep planning"
const SHORT_HINTS = "↑↓ · enter · esc"
const NOTE_HINTS = "enter send · esc back"
// Past this many lines the plan is taller than the band leaves room for.
const LONG_PLAN = 12
const planInput = z.looseObject({ plan: z.string().optional(), planFilePath: z.string().optional() })

// Claude finished a plan in plan mode and asks to start on it.
export function PlanBand(props: AskViewProps) {
  const fields = () => planInput.safeParse(props.ask.input).data
  // Claude Code sends the plan only once it is in its plan file.
  const plan = () => {
    const sent = fields()?.plan?.trim()
    if (sent) return sent
    const path = fields()?.planFilePath
    return path ? `_The plan is in ${path}._` : "_Claude sent no plan text._"
  }
  const [cursor, setCursor] = createSignal(0)
  const [noting, setNoting] = createSignal(false)
  let field: InputRenderable | undefined
  const respond = (index: number) => {
    const { requestId, input } = props.ask
    if (index === 0) props.onPlanApproved?.()
    props.onAnswer(index === 0 ? allowTool(requestId, input) : denyTool(requestId, TOOL_DECLINED))
  }
  const sendNote = (note: string) => {
    const text = note.trim()
    if (text) props.onAnswer(denyTool(props.ask.requestId, DECLINED_WITH_NOTE + text))
  }
  const typing = typingGuard()
  useKeyboard((key) => {
    if (typing(key)) return key.preventDefault()
    if (props.answered || covered()) return
    if (noting()) {
      if (key.name === "escape") setNoting(false)
      return
    }
    const choose = (index: number) => {
      key.preventDefault()
      if (index === 0) respond(0)
      else setNoting(true)
    }
    if (key.name === "up") setCursor(0)
    else if (key.name === "down") setCursor(1)
    else if (key.name === "return") choose(cursor())
    else if (key.name === "escape") respond(1)
    else if (key.name === "1" || key.name === "2") choose(Number(key.name) - 1)
  })

  return (
    <box
      flexDirection="column"
      flexShrink={1}
      marginBottom={1}
      paddingTop={1}
      paddingLeft={1}
      paddingRight={2}
      backgroundColor={theme.band ?? undefined}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={barChars}
      overflow="hidden"
    >
      <text wrapMode="none" flexShrink={0} fg={theme.accent} attributes={TextAttributes.BOLD}>
        Ready to code?
      </text>
      <box flexDirection="column" flexShrink={100} minHeight={0} marginTop={1}>
        <AskScroll focus={null}>
          <Markdown markdown={plan()} streaming={false} width={Math.max(1, props.width - 6)} />
        </AskScroll>
      </box>
      <box flexDirection="column" marginTop={1} flexShrink={0}>
        <Index each={CHOICES}>
          {(choice, index) => {
            const focused = () => !noting() && index === cursor()
            return (
              <text attributes={focused() ? TextAttributes.BOLD : TextAttributes.NONE}>
                <span style={{ fg: theme.accent }}>{focused() ? "❯ " : "  "}</span>
                <span style={{ fg: focused() ? theme.accent : theme.text }}>{`${index + 1}. ${choice()}`}</span>
              </text>
            )
          }}
        </Index>
      </box>
      <Show when={noting()}>
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme.accent} flexShrink={0}>
            {"  › "}
          </text>
          <input
            focused
            flexGrow={1}
            placeholder="tell Claude what to change"
            placeholderColor={theme.muted}
            textColor={theme.text}
            focusedTextColor={theme.text}
            ref={(element: InputRenderable) => (field = element)}
            onSubmit={() => sendNote(field?.value ?? "")}
          />
        </box>
      </Show>
      <box flexDirection="row" justifyContent="flex-end" flexShrink={0}>
        <text fg={theme.faint} flexShrink={1}>
          {noting()
            ? NOTE_HINTS
            : fitHints(plan().split("\n").length > LONG_PLAN ? SCROLL_HINTS : HINTS, SHORT_HINTS, props.width - 4)}
        </text>
      </box>
    </box>
  )
}
