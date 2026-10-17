import { type InputRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, Index, Show, untrack } from "solid-js"
import { z } from "zod"
import type { PermissionUpdate } from "../../protocol/messages.ts"
import { allowTool, denyTool, TOOL_DECLINED } from "../../protocol/outgoing.ts"
import { severe } from "../../session/ask.ts"
import { summarizeToolInput } from "../../session/tool-summary.ts"
import type { Ask } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { cut, toolLabel } from "../format.ts"
import { barChars } from "../user-message.tsx"
import { AskScroll } from "./ask-scroll.tsx"
import { fitHints, wrapRows } from "./fit.ts"
import { typingGuard } from "./typing.ts"
import type { AskViewProps } from "./ask-surface.tsx"

const HINTS = "↑↓ choose · enter confirm · n tell Claude instead · esc no"
const SHORT_HINTS = "↑↓ · enter · n · esc"
const NOTE_HINTS = "enter send · esc back"
const TARGET_ROWS = 6
const TEXT_ROWS = 3
// Below this many cells beside the title, the description starts on the next row.
const INLINE_ROOM = 10
const MODE_WORDS: Record<string, string> = { acceptEdits: "edits" }

type Choice = { kind: "yes" | "always" | "no"; before: string; subject: string; after: string }

const bashInput = z.looseObject({ command: z.string() })

function target(ask: Ask): string {
  const bash = ask.toolName === "Bash" ? bashInput.safeParse(ask.input) : null
  return bash?.success ? bash.data.command : summarizeToolInput(ask.input)
}

// Splits text into rows of at most `width` cells, the way the target line wraps it.
function targetRows(text: string, width: number): string[] {
  const rows: string[] = []
  for (const line of text.split("\n")) {
    let row = ""
    for (const char of line) {
      if (row !== "" && Bun.stringWidth(row + char) > width) {
        rows.push(row)
        row = ""
      }
      row += char
    }
    rows.push(row)
  }
  return rows
}

function oneLine(text: string): string {
  const [first = "", ...rest] = text.trim().split("\n")
  return rest.length > 0 ? `${first}…` : first
}

function modeWords(mode: string): string {
  return MODE_WORDS[mode] ?? mode.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
}

export function alwaysChoice(update: PermissionUpdate, toolName: string): Choice {
  const rule = update.rules?.[0]
  const text =
    update.type === "setMode"
      ? modeWords(update.mode ?? "")
      : update.type === "addDirectories"
        ? (update.directories?.join(", ") ?? "")
        : (rule?.ruleContent ?? toolLabel(rule?.toolName ?? ""))
  const subject = oneLine(text) || toolLabel(toolName)
  return update.type === "setMode"
    ? { kind: "always", before: "Yes, and allow ", subject, after: " for this session" }
    : { kind: "always", before: "Yes, and always allow ", subject, after: " here" }
}

function choicesFor(ask: Ask): Choice[] {
  const yes: Choice = { kind: "yes", before: "Yes", subject: "", after: "" }
  const no: Choice = { kind: "no", before: "No", subject: "", after: "" }
  return ask.suggestion ? [yes, alwaysChoice(ask.suggestion, ask.toolName), no] : [yes, no]
}

function bandColors(ask: Ask) {
  const tone = severe(ask) ? theme.error : theme.warning
  if (!theme.rgb) return { tone, fill: undefined, line: undefined }
  return severe(ask)
    ? { tone, fill: theme.errorBand ?? undefined, line: theme.errorLine ?? undefined }
    : { tone, fill: theme.warningBand ?? undefined, line: theme.warningLine ?? undefined }
}

export function PermissionBand(props: AskViewProps) {
  const choices = () => choicesFor(props.ask)
  const colors = () => bandColors(props.ask)
  const rows = createMemo(() => {
    const text = target(props.ask)
    return text ? targetRows(text.replaceAll("\t", "    "), Math.max(1, props.width - 8)) : []
  })
  const hiddenRows = () => rows().length - TARGET_ROWS
  // The title and every choice stay in view, so the description and reason get three rows each and the
  // always-allow rule one.
  const inner = () => Math.max(1, props.width - 4)
  const title = () => cut(`! ${props.ask.displayName}`, inner())
  const description = createMemo(() => {
    if (!props.ask.description) return ""
    const lead = Bun.stringWidth(title()) + 2
    const inline = inner() - lead >= INLINE_ROOM
    const lines = wrapRows(props.ask.description, inner(), TEXT_ROWS, inline ? lead : 0)
    return (inline ? "  " : "\n") + lines.join("\n")
  })
  const reason = createMemo(() => wrapRows(props.ask.reason, inner(), TEXT_ROWS).join("\n"))
  const subject = (choice: Choice) =>
    cut(choice.subject, inner() - 5 - Bun.stringWidth(choice.before) - Bun.stringWidth(choice.after))
  const [cursor, setCursor] = createSignal(untrack(() => (severe(props.ask) ? choices().length - 1 : 0)))
  const [noting, setNoting] = createSignal(false)

  const respond = (choice: Choice) => {
    const { requestId, input, suggestion } = props.ask
    if (choice.kind === "no") props.onAnswer(denyTool(requestId, TOOL_DECLINED))
    else if (choice.kind === "always" && suggestion) props.onAnswer(allowTool(requestId, input, [suggestion]))
    else props.onAnswer(allowTool(requestId, input))
  }

  let field: InputRenderable | undefined
  const sendNote = (note: string) => {
    const text = note.trim()
    if (text) props.onAnswer(denyTool(props.ask.requestId, text))
  }

  const typing = typingGuard()
  useKeyboard((key) => {
    if (typing(key)) return key.preventDefault()
    if (props.answered) return
    if (noting()) {
      if (key.name === "escape") setNoting(false)
      return
    }
    const last = choices().length - 1
    if (key.name === "up") setCursor((index) => Math.max(0, index - 1))
    else if (key.name === "down") setCursor((index) => Math.min(last, index + 1))
    else if (key.name === "return") {
      const choice = choices()[cursor()]
      if (choice) respond(choice)
    } else if (key.name === "escape") props.onAnswer(denyTool(props.ask.requestId, TOOL_DECLINED))
    else if (key.ctrl || key.meta) return
    else if (key.name === "n") {
      key.preventDefault()
      setNoting(true)
    } else if (!props.ask.defaultToNo && /^[1-9]$/.test(key.name)) {
      const choice = choices()[Number(key.name) - 1]
      if (choice) respond(choice)
    }
  })

  return (
    <box
      flexDirection="column"
      flexShrink={1}
      marginBottom={1}
      paddingTop={1}
      paddingLeft={1}
      paddingRight={2}
      backgroundColor={colors().fill}
      border={["left"]}
      borderColor={colors().tone}
      customBorderChars={barChars}
      overflow="hidden"
    >
      <text wrapMode="none" flexShrink={1} minHeight={1}>
        <span style={{ fg: colors().tone, bold: true }}>{title()}</span>
        <span style={{ fg: theme.text, bold: true }}>{description()}</span>
      </text>
      {/* The middle gives way long before the title does. */}
      <box flexDirection="column" flexShrink={100} minHeight={0}>
        <AskScroll focus={null}>
          <Show when={props.ask.reason}>
            <text fg={theme.muted} wrapMode="none">
              {reason()}
            </text>
          </Show>
          <Show when={rows().length > 0}>
            <box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} backgroundColor={colors().line}>
              <text fg={theme.text} wrapMode="none">
                {rows().slice(0, TARGET_ROWS).join("\n")}
              </text>
              <Show when={hiddenRows() > 0}>
                <text fg={theme.muted}>{`… ${hiddenRows()} more ${hiddenRows() === 1 ? "line" : "lines"}`}</text>
              </Show>
            </box>
          </Show>
        </AskScroll>
      </box>
      <box flexDirection="column" marginTop={1} flexShrink={0}>
        <Index each={choices()}>
          {(choice, index) => {
            const focused = () => !noting() && index === cursor()
            const color = () => (focused() ? colors().tone : theme.text)
            const attributes = () => (focused() ? TextAttributes.BOLD : TextAttributes.NONE)
            return (
              <box flexDirection="row">
                <text flexShrink={0} attributes={attributes()}>
                  <span style={{ fg: colors().tone }}>{focused() ? "❯ " : "  "}</span>
                  <span style={{ fg: color() }}>{`${index + 1}. `}</span>
                </text>
                <text wrapMode="word" attributes={attributes()}>
                  <span style={{ fg: color() }}>{choice().before}</span>
                  <span style={{ fg: theme.accent }}>{subject(choice())}</span>
                  <span style={{ fg: color() }}>{choice().after}</span>
                </text>
              </box>
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
            placeholder="tell Claude what to do instead"
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
          {noting() ? NOTE_HINTS : fitHints(HINTS, SHORT_HINTS, props.width - 4)}
        </text>
      </box>
    </box>
  )
}
