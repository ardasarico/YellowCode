import { RGBA } from "@opentui/core"
import { createSignal, For, Index, Match, Show, Switch } from "solid-js"
import type { Agent, Item, Session, ToolCall } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { useElapsedSeconds } from "./elapsed.ts"
import { AgentMark } from "./figures.tsx"
import { cut, cutPath, formatDuration } from "./format.ts"
import { relative, resultSummary, ToolCallRow } from "./tool-call.tsx"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)
const CONNECTOR = "  ⎿  "
const INDENT = " ".repeat(CONNECTOR.length)
const VISIBLE_STEPS = 3
// Shown while the Agent call's input is still streaming in.
const PENDING: Agent = {
  name: "agent",
  task: "",
  state: "running",
  toolUses: 0,
  durationMs: 0,
  report: "",
  error: null,
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function firstSentence(text: string): string {
  const line = text.trim().split("\n")[0] ?? ""
  const end = line.indexOf(". ")
  return end === -1 ? line : line.slice(0, end + 1)
}

function status(agent: Agent, tools: number, seconds: number): { text: string; color: RGBA } {
  const stats = `${count(tools, "tool")} · ${formatDuration(agent.durationMs || seconds * 1000)}`
  if (agent.state === "completed") return { text: `done · ${stats}`, color: theme.muted }
  if (agent.state === "failed") return { text: `failed · ${stats}`, color: theme.error }
  if (agent.state === "stopped") return { text: `stopped · ${stats}`, color: theme.warning }
  return { text: tools === 0 ? "starting…" : `running · ${stats}`, color: theme.accent }
}

function StepLine(props: { tool: ToolCall; cwd: string; prefix: string; prefixColor: RGBA; width: number }) {
  const color = () =>
    props.tool.status === "error" ? theme.error : props.tool.status === "running" ? theme.accent : theme.muted
  const target = () => relative(props.tool.summary, props.cwd)
  const label = () => `${props.tool.name}(${target()})`
  const room = () => props.width - props.prefix.length - 2
  const result = () => (props.tool.status === "running" ? "running…" : resultSummary(props.tool))
  return (
    <text wrapMode="none">
      <span style={{ fg: props.prefixColor }}>{props.prefix}</span>
      <span style={{ fg: color() }}>●</span>
      <span
        style={{ fg: theme.text }}
      >{` ${target().includes(" ") ? cut(label(), room()) : cutPath(label(), room())}`}</span>
      <span style={{ fg: color() }}>{`  ${cut(result(), Math.max(0, room() - label().length - 2))}`}</span>
    </text>
  )
}

export function AgentRow(props: {
  item: ToolCall
  index: number
  session: Session
  selected: boolean
  expanded: boolean
}) {
  const [width, setWidth] = createSignal(0)
  const color = () => theme.agents[props.index % theme.agents.length] ?? theme.accent
  const agent = () => props.item.agent ?? PENDING
  const running = () => agent().state === "running"
  const seconds = useElapsedSeconds(running)
  const children = () =>
    props.item.children.flatMap((id) => {
      const child = props.session.byId[id]
      return child ? [child] : []
    })
  const tools = () => children().filter((child): child is ToolCall => child.kind === "tool")
  const toolCount = () => Math.max(agent().toolUses, tools().length)
  const state = () => status(agent(), toolCount(), seconds())
  const cwd = () => props.session.info?.cwd ?? ""
  // A finished agent puts its status on a second line; while running or expanded it stays on the first.
  const twoLine = () => !running() && !props.expanded
  const outcome = () =>
    agent().state === "failed"
      ? { text: `failed · ${firstSentence(agent().error ?? agent().report)}`, color: theme.error }
      : state()
  const head = () => `   ${agent().name}(${agent().task})${twoLine() ? "" : `  ${state().text}`}`
  const recent = () => tools().slice(-VISIBLE_STEPS)
  const earlier = () => tools().length - recent().length

  return (
    <box
      id={props.item.id}
      flexDirection="column"
      backgroundColor={(props.selected ? theme.selection : null) ?? CLEAR}
      onSizeChange={function () {
        setWidth(this.width)
      }}
    >
      <box flexDirection="row">
        <AgentMark color={color()} state={agent().state} size={running() ? undefined : "medium"} />
        <text wrapMode="none">
          <span style={{ fg: theme.text, bold: true }}>{` ${agent().name}`}</span>
          <span
            style={{ fg: theme.text }}
          >{`(${cut(agent().task, Math.max(8, width() - head().length + agent().task.length))})`}</span>
          <Show when={!twoLine()}>
            <span style={{ fg: state().color }}>{`  ${state().text}`}</span>
          </Show>
        </text>
      </box>
      <Switch>
        <Match when={twoLine()}>
          <text wrapMode="none">
            <span style={{ fg: color() }}>{CONNECTOR}</span>
            <span style={{ fg: outcome().color }}>{cut(outcome().text, Math.max(0, width() - CONNECTOR.length))}</span>
          </text>
        </Match>
        <Match when={props.expanded}>
          <box flexDirection="column">
            <For each={children()}>
              {(child: Item, position) => (
                <box flexDirection="row">
                  <text fg={color()} flexShrink={0}>
                    {position() === 0 ? CONNECTOR : INDENT}
                  </text>
                  <box flexGrow={1} flexDirection="column">
                    <Switch>
                      <Match when={child.kind === "tool" ? child : undefined}>
                        {(tool) => <ToolCallRow item={tool()} cwd={cwd()} selected={false} expanded={false} />}
                      </Match>
                      <Match when={child.kind === "text" ? child : undefined}>
                        {(text) => <text fg={theme.muted}>{text().markdown}</text>}
                      </Match>
                    </Switch>
                  </box>
                </box>
              )}
            </For>
          </box>
        </Match>
        <Match when={running() && tools().length > 0}>
          <Show when={earlier() > 0}>
            <text>
              <span style={{ fg: color() }}>{CONNECTOR}</span>
              <span style={{ fg: theme.muted }}>{`… ${count(earlier(), "earlier tool")}`}</span>
            </text>
          </Show>
          <Index each={recent()}>
            {(tool, position) => (
              <StepLine
                tool={tool()}
                cwd={cwd()}
                prefix={position === 0 && earlier() === 0 ? CONNECTOR : INDENT}
                prefixColor={color()}
                width={width()}
              />
            )}
          </Index>
        </Match>
      </Switch>
    </box>
  )
}
