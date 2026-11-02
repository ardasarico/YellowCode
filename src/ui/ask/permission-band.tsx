import { infoStringToFiletype, type InputRenderable, TextAttributes } from "@opentui/core"
import { extname } from "node:path"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, Index, Show, untrack } from "solid-js"
import type { AskOption } from "../../agent/ask.ts"
import { severe } from "../../session/ask.ts"
import type { Ask } from "../../session/types.ts"
import { type WorkflowPlan, workflowPlan } from "../../session/workflow-script.ts"
import { theme } from "../../theme/theme.ts"
import { diffRows } from "../diff.ts"
import { DiffView } from "../diff-view.tsx"
import { cut, cutPath } from "../format.ts"
import { covered } from "../images.ts"
import { barChars } from "../user-message.tsx"
import { AskScroll } from "./ask-scroll.tsx"
import { fitHints, wrapRows } from "./fit.ts"
import { typingGuard } from "./typing.ts"
import type { AskViewProps } from "./ask-surface.tsx"

const hints = (agent: string) => `↑↓ choose · enter confirm · n tell ${agent} instead · esc no`
const SHORT_HINTS = "↑↓ · enter · n · esc"
const NO_NOTE_HINTS = "↑↓ choose · enter confirm · esc no"
const SHORT_NO_NOTE_HINTS = "↑↓ · enter · esc"
const SCRIPT_HINTS = "↑↓ choose · enter confirm · v script · esc no"
const SHORT_SCRIPT_HINTS = "↑↓ · enter · v · esc"
const NOTE_HINTS = "enter send · esc back"
const TARGET_ROWS = 6
const TEXT_ROWS = 3
const PLAN_ROWS = 8
const DIFF_ROWS = 10
// Below this many cells beside the title, the description starts on the next row.
const INLINE_ROOM = 10

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

type Choice = { id: string; before: string; subject: string; after: string }

// An MCP tool has no known fields, so every argument gets its own row.
function mcpArguments(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")
}

function target(ask: Ask): string {
  return ask.toolKind === "mcp" ? mcpArguments(ask.input) : ask.target
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

// The agent's own label, else "Yes" or "No", and for a lasting one what it covers and for how long.
export function choiceOf(option: AskOption): Choice {
  const { id } = option
  if (option.label !== null) return { id, before: option.label, subject: "", after: "" }
  const yes = option.effect === "allow"
  if (option.lasts === "once") return { id, before: yes ? "Yes" : "No", subject: "", after: "" }
  const subject = oneLine(option.subject ?? "")
  const verb = yes ? "allow " : "deny "
  const lead = yes ? "Yes, and " : "No, and "
  if (option.lasts === "session") return { id, before: `${lead}${verb}`, subject, after: " for this session" }
  if (option.lasts === "turn") return { id, before: `${lead}${verb}`, subject, after: " for this turn" }
  const after = option.lasts === "everywhere" ? " in every project" : " here"
  return { id, before: `${lead}always ${verb}`, subject, after }
}

function bandColors(ask: Ask) {
  const tone = severe(ask) ? theme.error : theme.warning
  if (!theme.rgb) return { tone, fill: undefined, line: undefined }
  return severe(ask)
    ? { tone, fill: theme.errorBand ?? undefined, line: theme.errorLine ?? undefined }
    : { tone, fill: theme.warningBand ?? undefined, line: theme.warningLine ?? undefined }
}

const onceNo = (option: AskOption) => option.effect === "deny" && option.lasts === "once"

// `note`: the agent takes a note with a no.
export function PermissionBand(props: AskViewProps & { note: boolean }) {
  const choices = () => props.ask.options.map(choiceOf)
  // Esc is a no that lasts once; `n` sends the note with the option that takes one.
  const refusal = () => props.ask.options.find(onceNo)
  const noted = () => (props.note ? props.ask.options.find((option) => option.note) : undefined)
  const colors = () => bandColors(props.ask)
  const rows = createMemo(() => {
    const text = target(props.ask)
    return text ? targetRows(text.replaceAll("\t", "    "), Math.max(1, props.width - 8)) : []
  })
  const hiddenRows = () => rows().length - TARGET_ROWS
  const plan = createMemo(() => (props.ask.toolKind === "workflow" ? workflowPlan(props.ask.input) : null))
  const plans = createMemo(() => {
    const shown = plan()
    return shown ? planRows(shown) : []
  })
  const hiddenPlans = () => plans().length - PLAN_ROWS
  // Each file's rows, the first files taking the room.
  const diffs = createMemo(() => {
    let room = DIFF_ROWS
    return (props.ask.diff ?? []).flatMap((file) => {
      const all = diffRows(file.hunks)
      const shown = all.slice(0, Math.max(0, room))
      room -= shown.length
      return shown.length > 0 ? [{ path: file.path, rows: shown, hidden: all.length - shown.length }] : []
    })
  })
  // The title and every choice stay in view, so the description and reason get three rows each and the
  // always-allow rule one.
  const inner = () => Math.max(1, props.width - 4)
  const title = () => cut(`! ${props.ask.displayName}`, inner())
  const from = () => (props.ask.agent ? cut(`  from ${props.ask.agent}`, inner() - Bun.stringWidth(title())) : "")
  const server = () => {
    const name = props.ask.server
    const room = inner() - Bun.stringWidth(title() + from())
    return name !== null && !props.ask.description ? cut(`  ${name} MCP server`, room) : ""
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
  // A severe ask starts on that no.
  const start = () => (severe(props.ask) ? Math.max(0, props.ask.options.findIndex(onceNo)) : 0)
  const [cursor, setCursor] = createSignal(untrack(start))
  const [noting, setNoting] = createSignal(false)

  const respond = (choice: Choice) => props.onAnswer({ type: "option", option: choice.id, note: null })

  let field: InputRenderable | undefined
  const sendNote = (note: string) => {
    const text = note.trim()
    const option = noted()
    if (text && option) props.onAnswer({ type: "option", option: option.id, note: text })
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
    } else if (key.name === "escape") {
      const option = refusal()
      if (option) props.onAnswer({ type: "option", option: option.id, note: null })
    } else if (key.ctrl || key.meta) return
    else if (key.name === "v" && plan()) {
      key.preventDefault()
      const shown = plan()
      if (shown) props.onOpenScript?.(shown.name || "workflow", shown.script)
    } else if (key.name === "n" && noted() && !plan()) {
      key.preventDefault()
      setNoting(true)
    } else if (!severe(props.ask) && /^[1-9]$/.test(key.name)) {
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
          <Index each={diffs()}>
            {(file) => (
              <box flexDirection="column" marginTop={1}>
                <Show when={diffs().length > 1}>
                  <text fg={theme.muted} wrapMode="none">
                    {cutPath(file().path, inner() - 2)}
                  </text>
                </Show>
                <DiffView
                  rows={file().rows}
                  tail={false}
                  expanded={false}
                  filetype={infoStringToFiletype(extname(file().path).slice(1))}
                />
                <Show when={file().hidden > 0}>
                  <text
                    fg={theme.muted}
                    paddingLeft={2}
                  >{`… ${file().hidden} more ${file().hidden === 1 ? "line" : "lines"}`}</text>
                </Show>
              </box>
            )}
          </Index>
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
            placeholder={`tell ${props.agent} what to do instead`}
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
              : noted()
                ? fitHints(hints(props.agent), SHORT_HINTS, props.width - 4)
                : fitHints(NO_NOTE_HINTS, SHORT_NO_NOTE_HINTS, props.width - 4)}
        </text>
      </box>
    </box>
  )
}
