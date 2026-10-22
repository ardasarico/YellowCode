import { type InputRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, Index, Show, untrack } from "solid-js"
import { z } from "zod"
import type { PermissionUpdate } from "../../protocol/messages.ts"
import { allowTool, DECLINED_WITH_NOTE, denyTool, TOOL_DECLINED } from "../../protocol/outgoing.ts"
import { severe } from "../../session/ask.ts"
import { summarizeToolInput } from "../../session/tool-summary.ts"
import type { Ask } from "../../session/types.ts"
import { type WorkflowPlan, workflowPlan } from "../../session/workflow-script.ts"
import { theme } from "../../theme/theme.ts"
import { cut, cutPath, mcpTool, toolLabel } from "../format.ts"
import { covered } from "../images.ts"
import { barChars } from "../user-message.tsx"
import { AskScroll } from "./ask-scroll.tsx"
import { fitHints, wrapRows } from "./fit.ts"
import { typingGuard } from "./typing.ts"
import type { AskViewProps } from "./ask-surface.tsx"

const HINTS = "↑↓ choose · enter confirm · n tell Claude instead · esc no"
const SHORT_HINTS = "↑↓ · enter · n · esc"
const SCRIPT_HINTS = "↑↓ choose · enter confirm · v script · esc no"
const SHORT_SCRIPT_HINTS = "↑↓ · enter · v · esc"
const NOTE_HINTS = "enter send · esc back"
const TARGET_ROWS = 6
const TEXT_ROWS = 3
const PLAN_ROWS = 8
// Below this many cells beside the title, the description starts on the next row.
const INLINE_ROOM = 10
const MODE_WORDS: Record<string, string> = { acceptEdits: "edits" }

type PlanRow = { lead: string; name: string; text: string }

function agentRows(agents: WorkflowPlan["loose"], lead: string): PlanRow[] {
  return agents.map((agent) => ({ lead, name: agent.label ? `${agent.label}  ` : "", text: agent.prompt }))
}

function planRows(plan: WorkflowPlan): PlanRow[] {
  return [
    ...plan.phases.flatMap((phase, index) => [
      { lead: `${index + 1}. `, name: phase.title, text: phase.detail ? `  ${phase.detail}` : "" },
      ...agentRows(phase.agents, "   · "),
    ]),
    ...agentRows(plan.loose, "· "),
  ]
}

type Choice = { kind: "yes" | "always" | "no"; before: string; subject: string; after: string }

const bashInput = z.looseObject({ command: z.string() })

// An MCP tool has no known fields, so every argument gets its own row.
function mcpArguments(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")
}

function target(ask: Ask): string {
  if (mcpTool(ask.toolName)) return mcpArguments(ask.input)
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
  // claude writes an absolute path in a rule with a second leading slash.
  const subject = (oneLine(text) || toolLabel(toolName)).replace(/^\/\//, "/")
  const lasts = lasting(update)
  if (lasts === "session") return { kind: "always", before: "Yes, and allow ", subject, after: " for this session" }
  const after = lasts === "everywhere" ? " in every project" : " here"
  return { kind: "always", before: "Yes, and always allow ", subject, after }
}

// Where claude keeps the update decides how long it lasts.
function lasting(update: PermissionUpdate): "session" | "here" | "everywhere" {
  if (update.destination === "session" || update.destination === "cliArg") return "session"
  if (update.destination === "userSettings") return "everywhere"
  if (update.destination) return "here"
  return update.type === "setMode" ? "session" : "here"
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
  const plan = createMemo(() => (props.ask.toolName === "Workflow" ? workflowPlan(props.ask.input) : null))
  const plans = createMemo(() => {
    const shown = plan()
    return shown ? planRows(shown) : []
  })
  const hiddenPlans = () => plans().length - PLAN_ROWS
  // The title and every choice stay in view, so the description and reason get three rows each and the
  // always-allow rule one.
  const inner = () => Math.max(1, props.width - 4)
  const title = () => cut(`! ${props.ask.displayName}`, inner())
  const from = () => (props.ask.agent ? cut(`  from ${props.ask.agent}`, inner() - Bun.stringWidth(title())) : "")
  const server = () => {
    const mcp = mcpTool(props.ask.toolName)
    const room = inner() - Bun.stringWidth(title() + from())
    return mcp && !props.ask.description ? cut(`  ${mcp.server} MCP server`, room) : ""
  }
  const description = createMemo(() => {
    if (!props.ask.description) return ""
    const lead = Bun.stringWidth(title() + from()) + 2
    const inline = inner() - lead >= INLINE_ROOM
    const lines = wrapRows(props.ask.description, inner(), TEXT_ROWS, inline ? lead : 0)
    return (inline ? "  " : "\n") + lines.join("\n")
  })
  const reason = createMemo(() => wrapRows(props.ask.reason, inner(), TEXT_ROWS).join("\n"))
  // A path keeps its end in view.
  const subject = (choice: Choice) =>
    (choice.subject.startsWith("/") ? cutPath : cut)(
      choice.subject,
      inner() - 5 - Bun.stringWidth(choice.before) - Bun.stringWidth(choice.after),
    )
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
    const last = choices().length - 1
    if (key.name === "up") setCursor((index) => Math.max(0, index - 1))
    else if (key.name === "down") setCursor((index) => Math.min(last, index + 1))
    else if (key.name === "return") {
      const choice = choices()[cursor()]
      if (choice) respond(choice)
    } else if (key.name === "escape") props.onAnswer(denyTool(props.ask.requestId, TOOL_DECLINED))
    else if (key.ctrl || key.meta) return
    else if (key.name === "v" && plan()) {
      key.preventDefault()
      const shown = plan()
      if (shown) props.onOpenScript?.(shown.name || "workflow", shown.script)
    } else if (key.name === "n" && !plan()) {
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
        <span style={{ fg: theme.muted }}>{from()}</span>
        <span style={{ fg: theme.muted }}>{server()}</span>
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
          <Show when={plans().length > 0}>
            <box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} backgroundColor={colors().line}>
              <Index each={plans().slice(0, PLAN_ROWS)}>
                {(row) => (
                  <text wrapMode="none">
                    <span style={{ fg: theme.faint }}>{row().lead}</span>
                    <span style={{ fg: theme.text }}>{row().name}</span>
                    <span style={{ fg: theme.muted }}>
                      {cut(row().text, inner() - 4 - Bun.stringWidth(row().lead + row().name))}
                    </span>
                  </text>
                )}
              </Index>
              <Show when={hiddenPlans() > 0}>
                <text fg={theme.muted}>{`… ${hiddenPlans()} more`}</text>
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
          {noting()
            ? NOTE_HINTS
            : plan()
              ? fitHints(SCRIPT_HINTS, SHORT_SCRIPT_HINTS, props.width - 4)
              : fitHints(HINTS, SHORT_HINTS, props.width - 4)}
        </text>
      </box>
    </box>
  )
}
