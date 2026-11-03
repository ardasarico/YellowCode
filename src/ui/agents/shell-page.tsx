import { RGBA } from "@opentui/core"
import { Show } from "solid-js"
import { exitCode, shellNodeId, shellStartedBy, stoppedByTimeLimit } from "../../session/shells.ts"
import type { Task } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { cut, formatClock, formatDuration } from "../format.ts"
import { useDuration } from "./agent-line.tsx"
import { MetaLine, type PageProps } from "./agent-page.tsx"
import { shellColor } from "./agent-line.tsx"

const ID_PREFIX = shellNodeId("")
// The page draws its own last line, so the tail's exit marker goes.
const EXIT_MARKER = /\s*\[(?:killed|exited with code \d+)\]\s*$/

function status(task: Task, duration: string): string {
  const code = exitCode(task)
  const exit = code === null ? "" : `exit ${code}`
  if (task.state === "running") return `running · ${duration}`
  if (task.state === "stopped")
    return stoppedByTimeLimit(task) ? `stopped · time limit · ${duration}` : `stopped · ${duration}`
  return [task.state === "failed" ? "failed" : "done", exit, duration].filter(Boolean).join(" · ")
}

function lastLine(task: Task, duration: string): { text: string; color: RGBA } {
  const code = exitCode(task)
  if (task.state === "running") return { text: `$ running… ${duration}`, color: theme.accent }
  if (task.state === "stopped") return { text: "stopped", color: theme.warning }
  if (code === null) return { text: task.state === "failed" ? "failed" : "done", color: shellColor(task.state) }
  return { text: `exited with code ${code}`, color: code === 0 ? theme.muted : theme.error }
}

// A progress line redraws itself after each \r, so only its last state is kept.
function lastStates(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const row = line.replace(/\r+$/, "")
      return row.slice(row.lastIndexOf("\r") + 1)
    })
    .join("\n")
}

function body(task: Task): { text: string; color: RGBA } {
  // Some agents give a shell's output only once it ends.
  if (task.output === null)
    return { text: task.state === "running" ? "output shows when it ends" : "output not available", color: theme.muted }
  const text = lastStates(Bun.stripANSI(task.output).replace(EXIT_MARKER, "")).trimEnd()
  if (text) return { text, color: theme.text }
  return { text: task.state === "running" ? "no output yet" : "no output", color: theme.muted }
}

export function ShellPage(props: PageProps) {
  const task = () => props.session.tasks[props.node.id.slice(ID_PREFIX.length)]
  const duration = useDuration(() => props.node)
  const time = () => formatDuration(duration())
  return (
    <Show when={task()}>
      {(shown) => {
        const head = () => status(shown(), time())
        // The name gives way first so the state stays, down to a third of the row.
        const name = () =>
          cut(props.node.name, Math.max(Math.floor(props.width / 3), props.width - Bun.stringWidth(head()) - 4))
        const right = () =>
          cut(shown().command, Math.max(0, props.width - Bun.stringWidth(`$ ${name()}  ${head()}`) - 2))
        const meta = () => [
          "background shell",
          `started by ${shellStartedBy(props.session, shown())}`,
          shown().endedAt === null ? "" : `finished ${formatClock(shown().endedAt ?? 0)}`,
        ]
        const shownBody = () => body(shown())
        const last = () => lastLine(shown(), time())
        return (
          <box flexDirection="column" flexGrow={1}>
            <box flexDirection="row" height={1} flexShrink={0}>
              <text wrapMode="none" flexGrow={1} flexShrink={1}>
                <span style={{ fg: shellColor(shown().state) }}>$</span>
                <span style={{ fg: theme.text, bold: true }}>{` ${name()}`}</span>
                <span style={{ fg: shellColor(shown().state) }}>{`  ${head()}`}</span>
              </text>
              <text wrapMode="none" flexShrink={0} fg={theme.muted}>
                {right() ? ` ${right()}` : ""}
              </text>
            </box>
            <text fg={theme.frame} wrapMode="none" flexShrink={0}>
              {"─".repeat(Math.max(0, props.width))}
            </text>
            <MetaLine parts={meta()} width={props.width} />
            <scrollbox
              ref={props.scrollRef}
              stickyScroll
              stickyStart="bottom"
              flexGrow={1}
              marginTop={1}
              paddingRight={1}
              verticalScrollbarOptions={{
                trackOptions: { foregroundColor: theme.muted, backgroundColor: RGBA.fromValues(0, 0, 0, 0) },
              }}
            >
              <box flexDirection="column" gap={1}>
                <box flexDirection="column">
                  <Show when={shown().truncated}>
                    <text fg={theme.faint} wrapMode="none">
                      {`… earlier output cut (${Math.round(shown().outputBytes / 1024)} KiB in total)`}
                    </text>
                  </Show>
                  <text fg={shownBody().color} wrapMode="char">
                    {shownBody().text}
                  </text>
                </box>
                <text fg={last().color} wrapMode="none">
                  {last().text}
                </text>
              </box>
            </scrollbox>
          </box>
        )
      }}
    </Show>
  )
}
