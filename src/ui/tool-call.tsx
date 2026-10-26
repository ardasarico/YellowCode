import { infoStringToFiletype, RGBA } from "@opentui/core"
import { extname } from "node:path"
import { createComponent, createMemo, createSignal, ErrorBoundary, Index, Show } from "solid-js"
import type { ModToolCall } from "../mods/api.ts"
import { reportModError, rowPartsFor } from "../mods/registry.ts"
import { askUserQuestionInput, OWN_ASK } from "../protocol/messages.ts"
import { DECLINED_WITH_NOTE, NOT_SHOWN, QUESTION_TO_CHAT, SUBAGENT_ASK, TOOL_DECLINED } from "../protocol/outgoing.ts"
import { answersInResult, askKeys, severe } from "../session/ask.ts"
import type { Ask, Task, ToolCall } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { writtenContent } from "../session/tool-summary.ts"
import { useDuration } from "./agents/agent-line.tsx"
import { addedRows, diffRows } from "./diff.ts"
import { DiffView } from "./diff-view.tsx"
import { useElapsedSeconds } from "./elapsed.ts"
import { FoldHint } from "./fold-hint.tsx"
import { cut, cutPath, formatDuration, mcpTool } from "./format.ts"
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
    const content = writtenContent(tool.input)
    return content === null ? "created" : `created · ${count(addedRows(content).length, "line")}`
  }
  if (tool.patch) {
    const changed = tool.patch.flatMap((hunk) => hunk.lines)
    const added = changed.filter((line) => line.startsWith("+")).length
    const removed = changed.filter((line) => line.startsWith("-")).length
    return `+${added} −${removed}`
  }
  if (tool.unchanged) return "unchanged"
  if (tool.name === "Read") return count(lines.filter((line) => /^\s*\d+\t/.test(line)).length, "line")
  if (tool.name === "Glob") return count(lines.length, "file")
  if (lines.length === 0) return "no output"
  return lines.length === 1 ? (lines[0] ?? "") : count(lines.length, "line")
}

// Claude starts a shell in the background, or the user sends a running one there with Ctrl+B.
export function isBackgroundShell(tool: ToolCall, task: Pick<Task, "background"> | null): boolean {
  const input = tool.input
  const asked = typeof input === "object" && input !== null && "run_in_background" in input
  const background = (asked && input.run_in_background === true) || task?.background === true
  return tool.name === "Bash" && tool.taskId !== null && background
}

// The result of a background Bash only says it was launched, so the line follows the shell's task instead.
export function toolLines(
  tool: ToolCall,
  ask: Ask | null,
  shell: Pick<Task, "state" | "background"> | null,
  elapsedMs: number,
): string[] {
  const question = tool.name === "AskUserQuestion" || tool.name === OWN_ASK
  if (ask?.status === "pending") return [question ? "waiting for your answer" : "waiting for your approval"]
  if (ask?.status === "denied") return [deniedLine(ask)]
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

function shellColor(shell: Task | null) {
  if (shell?.state === "running") return theme.accent
  if (shell?.state === "failed") return theme.error
  if (shell?.state === "stopped") return theme.warning
  return theme.muted
}

function backToChat(ask: Ask): boolean {
  return ask.status === "denied" && ask.denial === QUESTION_TO_CHAT
}

// claude's result for a call the user interrupted.
const INTERRUPTED_CALL = "The user doesn't want to proceed with this tool use."

function knownDenial(denial: string): string | null {
  if (denial.startsWith(NOT_SHOWN)) return `rejected · ${denial.slice(NOT_SHOWN.length).replace(/\.$/, "")}`
  if (denial === QUESTION_TO_CHAT) return "back to chat"
  if (denial === SUBAGENT_ASK) return "sent back to the main agent"
  if (denial === TOOL_DECLINED) return "denied"
  return null
}

export function deniedLine(ask: Pick<Ask, "denial">): string {
  const known = knownDenial(ask.denial)
  if (known) return known
  const said = ask.denial.startsWith(DECLINED_WITH_NOTE) ? ask.denial.slice(DECLINED_WITH_NOTE.length) : ask.denial
  const note = said.trim().replaceAll("\n", " ")
  return note ? `denied · ${note}` : "denied"
}

// A question read back from a transcript has no ask, only its error result, which reads as a live one would.
function settledQuestion(tool: ToolCall): string | null {
  if ((tool.name !== "AskUserQuestion" && tool.name !== OWN_ASK) || tool.status !== "error") return null
  if (tool.result.startsWith(INTERRUPTED_CALL)) return "cancelled"
  if (tool.result.startsWith(DECLINED_WITH_NOTE)) return deniedLine({ denial: tool.result })
  return knownDenial(tool.result)
}

export function answerLines(tool: ToolCall, ask: Ask | null): string[] {
  const { answers, notes } = ask?.status === "answered" ? ask : answersInResult(tool.result, askKeys(tool.input))
  const questions = askUserQuestionInput.safeParse(tool.input).data?.questions ?? []
  return Object.entries(answers).map(([question, answer]) => {
    const header = questions.find((entry) => entry.question === question)?.header ?? question
    const shown = answer.replaceAll("\n", " ")
    const note = notes[question]?.replaceAll("\n", " ")
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
    if (background() && !waiting() && !denied()) return shellColor(shell())
    if (props.ask && waiting()) return severe(props.ask) ? theme.error : theme.warning
    if (denied() || props.item.status === "error") return theme.error
    if (props.item.status === "stopped") return theme.warning
    return props.item.status === "running" ? theme.accent : theme.muted
  }
  const info: ModToolCall = {
    get name() {
      return props.item.name
    },
    get short() {
      return mcpTool(props.item.name)?.tool ?? props.item.name
    },
    get source() {
      return mcpTool(props.item.name)?.server ?? null
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
  // Our own ask stands in for the stock one, so it reads like it.
  const label = () => {
    const title = modRow()?.parts.title
    if (title !== undefined) return { server: "", tool: title }
    if (props.item.name === OWN_ASK) return { server: "", tool: "AskUserQuestion" }
    const mcp = mcpTool(props.item.name)
    return mcp ? { server: `${mcp.server}/`, tool: mcp.tool } : { server: "", tool: props.item.name }
  }
  const target = () => {
    const text = modRow()?.parts.text
    if (text !== undefined) return cut(text, width() - Bun.stringWidth(label().tool) - 4)
    const summary = props.item.summary || (label().server ? mcpArguments(props.item.input) : "")
    const value = relative(summary, props.cwd)
    const room = width() - Bun.stringWidth(label().server + label().tool) - 4
    return value.includes(" ") ? cut(value, room) : cutPath(value, room)
  }
  // While a command runs, Claude's description of it says what it is waiting for.
  const description = () => {
    const input = props.item.input
    if (!running() || props.item.name !== "Bash" || typeof input !== "object" || input === null) return ""
    const text = "description" in input && typeof input.description === "string" ? input.description : ""
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
    if (tool.name !== "Bash" || tool.status !== "done" || denied() || background() || waiting()) return null
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

  // A new file reads as code from its first line; a long one folds after a few.
  const created = () => {
    const tool = props.item
    const content = tool.status === "done" && !denied() && tool.createdFile ? writtenContent(tool.input) : null
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
          </text>
        }
      >
        <text wrapMode="none">
          <span style={{ fg: theme.shell }}>!</span>
          <span style={{ fg: theme.text, bold: true }}>{` ${cut(props.item.summary, width() - 2)}`}</span>
        </text>
      </Show>
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
      <Show when={props.item.local?.told === false && props.item.status !== "running"}>
        <text wrapMode="none" fg={theme.faint}>
          {`${LINE_INDENT}Claude sees this with your next message`}
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
