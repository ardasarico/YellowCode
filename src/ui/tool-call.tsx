import { infoStringToFiletype, RGBA } from "@opentui/core"
import { extname } from "node:path"
import { createComponent, createMemo, createSignal, ErrorBoundary, Index, Show } from "solid-js"
import type { AskOutcome } from "../agent/ask.ts"
import type { ModToolCall } from "../mods/api.ts"
import { reportModError, rowPartsFor } from "../mods/registry.ts"
import { severe } from "../session/ask.ts"
import type { Ask, Task, ToolCall } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { isBackgroundShell } from "../session/tool-summary.ts"
import { shellColor, useDuration } from "./agents/agent-line.tsx"
import { addedRows, diffRows } from "./diff.ts"
import { DiffView } from "./diff-view.tsx"
import { useElapsedSeconds } from "./elapsed.ts"
import { FoldHint, foldHintWidth } from "./fold-hint.tsx"
import { cut, cutPath, formatDuration } from "./format.ts"
import { ImageLabels } from "./image-label.tsx"
import { CodeBlock } from "./markdown/code-block.tsx"
import { FOLDED_CODE, LONG_CODE } from "./markdown/folds.ts"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
const RESULT_INDENT = "  ⎿  "
const LINE_INDENT = " ".repeat(RESULT_INDENT.length)
const TAIL_LINES = 3

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

export function resultSummary(tool: ToolCall): string {
  if (tool.status === "stopped") return "stopped"
  const lines = tool.result.split("\n").filter((line) => line.trim() !== "")
  if (tool.status === "error") {
    const exit = /^Exit code (\d+)$/.exec(lines[0] ?? "")
    if (!exit) return lines[0] ?? "failed"
    return [`exit ${exit[1]}`, lines[1]].filter(Boolean).join(" · ")
  }
  if (tool.createdFile) {
    return tool.content === null ? "created" : `created · ${count(addedRows(tool.content).length, "line")}`
  }
  if (tool.patch) {
    const changed = tool.patch.flatMap((hunk) => hunk.lines)
    const added = changed.filter((line) => line.startsWith("+")).length
    const removed = changed.filter((line) => line.startsWith("-")).length
    return `+${added} −${removed}`
  }
  if (tool.unchanged) return "unchanged"
  if (tool.count) return count(tool.count.n, tool.count.noun)
  if (lines.length === 0) return "no output"
  return lines.length === 1 ? (lines[0] ?? "") : count(lines.length, "line")
}

// The result of a background Bash only says it was launched, so the line follows the shell's task instead.
export function toolLines(
  tool: ToolCall,
  ask: Ask | null,
  shell: Pick<Task, "state" | "background"> | null,
  elapsedMs: number,
): string[] {
  const question = tool.toolKind === "question"
  if (ask?.status === "pending") return [question ? "waiting for your answer" : "waiting for your approval"]
  if (ask?.status === "denied") return [deniedLine({ why: ask.why ?? "declined", note: ask.note })]
  if (ask?.status === "cancelled") return ["cancelled"]
  if (isBackgroundShell(tool, shell)) {
    if (!shell) return ["in background"]
    return [shell.state === "running" ? `running in background · ${formatDuration(elapsedMs)}` : "ran in background"]
  }
  if (tool.status === "running") return [`running… ${Math.floor(elapsedMs / 1000)}s`]
  // A `!` command's short output is the point of running it, so it shows whole.
  const output = tool.local && tool.result.trim() ? tool.result.trimEnd().split("\n") : []
  if (output.length > 0 && output.length <= TAIL_LINES + 1) return output
  const settled = ask ? null : settledQuestion(tool)
  if (settled) return [settled]
  const answers = question ? answerLines(tool, ask) : []
  return answers.length > 0 ? answers : [resultSummary(tool)]
}

function backToChat(ask: Ask): boolean {
  return ask.status === "denied" && ask.why === "chat"
}

type Denied = Extract<AskOutcome, { status: "denied" }>

export function deniedLine(denied: Pick<Denied, "why" | "note">): string {
  if (denied.why === "unshown") return `rejected · ${denied.note}`
  if (denied.why === "chat") return "back to chat"
  if (denied.why === "subagent") return "sent back to the main agent"
  const note = denied.note.trim().replaceAll("\n", " ")
  return note ? `denied · ${note}` : "denied"
}

// A question read back from a transcript has no ask, only the call's outcome, which reads as a live one would.
function settledQuestion(tool: ToolCall): string | null {
  if (tool.toolKind !== "question" || tool.status !== "error") return null
  if (tool.outcome?.status === "cancelled") return "cancelled"
  return tool.outcome?.status === "denied" ? deniedLine(tool.outcome) : null
}

export function answerLines(tool: ToolCall, ask: Ask | null): string[] {
  const told = tool.outcome?.status === "answered" ? tool.outcome : { answers: {}, notes: {} }
  const { answers, notes }: Pick<Ask, "answers" | "notes"> = ask?.status === "answered" ? ask : told
  const pages = tool.questions && "pages" in tool.questions ? tool.questions.pages : []
  return Object.entries(answers).map(([key, answer]) => {
    const header = pages.find((page) => page.key === key)?.header ?? key
    const shown = answer.replaceAll("\n", " ")
    const note = notes[key]?.replaceAll("\n", " ")
    return note ? `${header}: ${shown} · ${note}` : `${header}: ${shown}`
  })
}

// MCP inputs have no known field to summarize, so a single value is shown alone and several as `key: value` pairs.
function mcpArguments(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  const pairs = Object.entries(input).flatMap(([key, value]) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [[key, String(value).split("\n")[0] ?? ""]]
      : [],
  )
  if (pairs.length === 1) return pairs[0]?.[1] ?? ""
  return pairs.map(([key, value]) => `${key}: ${value}`).join(", ")
}

export function relative(target: string, cwd: string): string {
  return cwd && target.startsWith(`${cwd}/`) ? target.slice(cwd.length + 1) : target
}

export function ToolCallRow(props: {
  item: ToolCall
  ask?: Ask | null
  task?: Task | null
  cwd: string
  selected: boolean
  expanded: boolean
  selection?: string | null
  onOpenShell?: (taskId: string) => void
  onOpenImage?: (id: string) => void
  // A finished call folded to its header line, with its result at the end.
  brief?: boolean
  onToggle?: (id: string) => void
}) {
  const [width, setWidth] = createSignal(0)
  const waiting = () => props.ask?.status === "pending"
  const denied = () => props.ask?.status === "denied"
  const running = () => props.item.status === "running" && !waiting()
  const seconds = useElapsedSeconds(running)
  const background = () => isBackgroundShell(props.item, props.task ?? null)
  const shell = () => (background() ? (props.task ?? null) : null)
  const shellMs = useDuration(() => ({
    state: shell()?.state ?? "completed",
    durationMs: 0,
    startedAt: shell()?.startedAt ?? null,
  }))
  const color = () => {
    if (props.ask && (backToChat(props.ask) || props.ask.status === "cancelled")) return theme.muted
    const settled = props.ask ? null : settledQuestion(props.item)
    if (settled === "back to chat" || settled === "cancelled") return theme.muted
    if (background() && !waiting() && !denied()) return shell() ? shellColor(shell()!.state) : theme.muted
    if (props.ask && waiting()) return severe(props.ask) ? theme.error : theme.warning
    if (denied() || props.item.status === "error") return theme.error
    if (props.item.status === "stopped") return theme.warning
    return props.item.status === "running" ? theme.accent : theme.muted
  }
  const info: ModToolCall = {
    get name() {
      return props.item.name
    },
    get kind() {
      return props.item.toolKind
    },
    get short() {
      return props.item.title
    },
    get source() {
      return props.item.server
    },
    get input() {
      return props.item.input
    },
    get result() {
      return props.item.result
    },
    get status() {
      return props.item.status
    },
    get summary() {
      return props.item.summary
    },
  }
  // A mod may draw the row's name, summary and result lines.
  const modRow = createMemo(() => (props.item.local ? null : rowPartsFor(info)))
  const label = () => {
    const title = modRow()?.parts.title
    if (title !== undefined) return { server: "", tool: title }
    const server = props.item.server
    return { server: server === null ? "" : `${server}/`, tool: props.item.title }
  }
  const targetText = () =>
    modRow()?.parts.text ??
    relative(props.item.summary || (label().server ? mcpArguments(props.item.input) : ""), props.cwd)
  const hintWidth = () => foldHintWidth({ open: false, selected: props.selected, gap: " · " })
  // A folded call's result takes the room its target leaves, and at least a third of the line.
  const briefResult = () => {
    const free = width() - Bun.stringWidth(label().server + label().tool + targetText()) - 7 - hintWidth()
    return cut((lines()[0] ?? "").trim(), Math.max(free, Math.floor(width() / 3)))
  }
  const after = () => (folded() ? Bun.stringWidth(` · ${briefResult()}`) + hintWidth() : 0)
  const target = () => {
    const value = targetText()
    if (modRow()?.parts.text !== undefined) return cut(value, width() - Bun.stringWidth(label().tool) - 4 - after())
    const room = width() - Bun.stringWidth(label().server + label().tool) - 4 - after()
    return value.includes(" ") ? cut(value, room) : cutPath(value, room)
  }
  // While a command runs, the agent's description of it says what it is waiting for.
  const description = () => {
    if (!running() || props.item.toolKind !== "shell") return ""
    const text = props.item.detail ?? ""
    const room = width() - Bun.stringWidth(label().server + label().tool + target()) - 6
    return text ? cut(text, room) : ""
  }
  // An image result has no text, so its labels stand in for the summary line.
  const imageOnly = () => props.item.images.length > 0 && props.item.status === "done" && !props.item.result.trim()
  const lines = () =>
    imageOnly() ? [] : toolLines(props.item, props.ask ?? null, shell(), background() ? shellMs() : seconds() * 1000)
  // A long command output shows its last lines, which usually hold the outcome.
  const tail = () => {
    const tool = props.item
    if (tool.toolKind !== "shell" || tool.status !== "done" || denied() || background() || waiting()) return null
    const shown = tool.result.trimEnd().split("\n")
    return shown.length > TAIL_LINES + 1 ? { hidden: shown.length - TAIL_LINES, last: shown.slice(-TAIL_LINES) } : null
  }
  const lineColor = () => (props.item.status === "done" && !denied() && !background() ? theme.muted : color())
  // The user's answer outranks a replayed result, which may come from a different answer.
  const output = () => (denied() || background() || props.ask?.status === "answered" ? "" : props.item.result)
  const diff = () => {
    const tool = props.item
    if (tool.status !== "done" || denied()) return null
    return !tool.createdFile && tool.patch && tool.patch.length > 0 ? { rows: diffRows(tool.patch), tail: false } : null
  }

  const folded = () => props.brief === true && !props.expanded

  // A new file reads as code from its first line; a long one folds after a few.
  const created = () => {
    const tool = props.item
    const content = tool.status === "done" && !denied() && tool.createdFile ? tool.content : null
    if (content === null) return null
    const all = content.replace(/\n$/, "").split("\n")
    const hidden = all.length > LONG_CODE && !props.expanded ? all.length - FOLDED_CODE : 0
    return {
      code: hidden > 0 ? all.slice(0, FOLDED_CODE).join("\n") : all.join("\n"),
      hidden,
      long: all.length > LONG_CODE,
    }
  }

  return (
    <box
      id={props.item.id}
      flexDirection="column"
      backgroundColor={(props.selected ? theme.selection : null) ?? CLEAR}
      onSizeChange={function () {
        setWidth(this.width)
      }}
      onMouseDown={(event) => {
        if (props.brief && props.onToggle) {
          event.preventDefault()
          props.onToggle(props.item.id)
          return
        }
        const taskId = props.item.taskId
        if (!background() || !taskId || !props.onOpenShell) return
        event.preventDefault()
        props.onOpenShell(taskId)
      }}
    >
      <Show
        when={props.item.local}
        fallback={
          <text wrapMode="none">
            <span style={{ fg: color() }}>●</span>
            <span style={{ fg: theme.muted }}>{` ${label().server}`}</span>
            <span style={{ fg: theme.text, bold: true }}>{label().tool}</span>
            <span style={{ fg: theme.text }}>
              {modRow()?.parts.text !== undefined ? `  ${target()}` : `(${target()})`}
            </span>
            <span style={{ fg: theme.muted }}>{description() ? `  ${description()}` : ""}</span>
            <Show when={props.brief}>
              <span style={{ fg: lineColor() }}>{folded() ? ` · ${briefResult()}` : ""}</span>
              <FoldHint open={props.expanded} selected={props.selected} gap=" · " />
            </Show>
          </text>
        }
      >
        <text wrapMode="none">
          <span style={{ fg: theme.shell }}>!</span>
          <span style={{ fg: theme.text, bold: true }}>{` ${cut(props.item.summary, width() - 2)}`}</span>
        </text>
      </Show>
      {/* Opened, a folded call shows its output right under its header. */}
      <Show when={!props.brief}>
        <Show
          when={modRow()?.parts.body}
          fallback={
            <Show
              when={tail()}
              fallback={
                <Index each={lines()}>
                  {(line, index) => (
                    <text wrapMode="none">
                      <span style={{ fg: theme.frame }}>{index === 0 ? RESULT_INDENT : LINE_INDENT}</span>
                      <span style={{ fg: lineColor() }}>{cut(line(), width() - RESULT_INDENT.length)}</span>
                    </text>
                  )}
                </Index>
              }
            >
              {(shown) => (
                <>
                  <text wrapMode="none">
                    <span style={{ fg: theme.frame }}>{RESULT_INDENT}</span>
                    <span style={{ fg: theme.muted }}>{props.expanded ? resultSummary(props.item) : ""}</span>
                    <FoldHint
                      open={props.expanded}
                      selected={props.selected}
                      hidden={shown().hidden}
                      gap={props.expanded ? " · " : undefined}
                    />
                  </text>
                  <Show when={!props.expanded}>
                    <Index each={shown().last}>
                      {(line) => (
                        <text wrapMode="none">
                          <span style={{ fg: theme.frame }}>{LINE_INDENT}</span>
                          <span style={{ fg: theme.muted }}>{cut(line(), width() - RESULT_INDENT.length)}</span>
                        </text>
                      )}
                    </Index>
                  </Show>
                </>
              )}
            </Show>
          }
        >
          {(body) => (
            <ErrorBoundary
              fallback={(error: unknown) => {
                const mod = modRow()?.mod
                if (mod) queueMicrotask(() => reportModError(mod, error))
                return null
              }}
            >
              {createComponent(body(), {
                get width() {
                  return width()
                },
                get expanded() {
                  return props.expanded
                },
              })}
            </ErrorBoundary>
          )}
        </Show>
      </Show>
      <Show when={props.item.local?.told === false && props.item.status !== "running"}>
        <text wrapMode="none" fg={theme.faint}>
          {`${LINE_INDENT}The agent sees this with your next message`}
        </text>
      </Show>
      <ImageLabels
        itemId={props.item.id}
        images={props.item.images}
        prefix={(index) => (index === 0 && lines().length === 0 ? RESULT_INDENT : LINE_INDENT)}
        selection={props.selection}
        onOpen={props.onOpenImage}
      />
      <Show when={created()}>
        {(file) => (
          <box flexDirection="column" gap={1}>
            <CodeBlock lang={extname(props.item.summary).slice(1)} code={file().code} streaming={false} unlabeled />
            <Show when={file().long}>
              <box paddingLeft={2}>
                <text fg={theme.muted}>
                  <FoldHint open={props.expanded} selected={props.selected} hidden={file().hidden} />
                </text>
              </box>
            </Show>
          </box>
        )}
      </Show>
      <Show
        when={diff()}
        fallback={
          <Show when={props.expanded && output() && !created()}>
            <box paddingLeft={RESULT_INDENT.length}>
              <text fg={theme.text}>{output().trimEnd()}</text>
            </box>
          </Show>
        }
      >
        {(shown) => (
          <DiffView
            rows={shown().rows}
            tail={shown().tail}
            expanded={props.expanded}
            filetype={infoStringToFiletype(extname(props.item.summary).slice(1))}
          />
        )}
      </Show>
    </box>
  )
}
