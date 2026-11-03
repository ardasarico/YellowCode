import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { createMemo, For, type JSX, Match, Show, Switch, untrack } from "solid-js"
import { unwrap } from "solid-js/store"
import type { Item, Session, ToolCall } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { AgentMark } from "../figures.tsx"
import { cut, formatDuration, formatTokens, modelName } from "../format.ts"
import { Markdown } from "../markdown/markdown.tsx"
import { ThinkingRow } from "../thinking.tsx"
import { ToolCallRow } from "../tool-call.tsx"
import { barChars } from "../user-message.tsx"
import { AgentLine, count, useDuration, WorkflowLine } from "./agent-line.tsx"
import { agentColor } from "./tree-rows.tsx"
import { isAgentCall, isWorkflowCall, type TreeNode } from "./tree.ts"

export type PageProps = {
  session: Session
  node: TreeNode
  startedBy: string
  width: number
  scrollRef: (scroll: ScrollBoxRenderable) => void
}

export const tokens = (n: number) => (n > 0 ? `${formatTokens(n)} tokens` : "")

function stateText({ kind, state }: TreeNode): { text: string; color: RGBA } {
  if (state === "completed") return { text: kind === "child" ? "idle" : "done", color: theme.muted }
  if (state === "failed") return { text: "failed", color: theme.error }
  if (state === "stopped") return { text: "stopped", color: theme.warning }
  if (state === "queued") return { text: "queued", color: theme.faint }
  return { text: "running", color: theme.accent }
}

export function PageHeader(props: { node: TreeNode; stats: string; right: string; width: number }) {
  const state = () => stateText(props.node)
  const status = () => [state().text, props.stats].filter(Boolean).join(" · ")
  // The mark and the spaces take five columns. The name gives way first so the state stays, down to a third of the row.
  const name = () =>
    cut(props.node.name, Math.max(Math.floor(props.width / 3), props.width - Bun.stringWidth(status()) - 5))
  const right = () => cut(props.right, Math.max(0, props.width - Bun.stringWidth(`${name()}${status()}`) - 6))
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" height={1}>
        <AgentMark
          color={agentColor(props.node.colorIndex)}
          state={props.node.state === "queued" ? "running" : props.node.state}
          size={props.node.state === "running" ? undefined : "medium"}
        />
        <text wrapMode="none" flexGrow={1} flexShrink={1}>
          <span style={{ fg: theme.text, bold: true }}>{` ${name()}`}</span>
          <span style={{ fg: state().color }}>{`  ${status()}`}</span>
        </text>
        <text wrapMode="none" flexShrink={0} fg={theme.muted}>
          {right() ? ` ${right()}` : ""}
        </text>
      </box>
      <text fg={theme.frame} wrapMode="none">
        {"─".repeat(Math.max(0, props.width))}
      </text>
    </box>
  )
}

export function MetaLine(props: { parts: string[]; width: number }) {
  return (
    <text fg={theme.muted} wrapMode="none" flexShrink={0}>
      {cut(props.parts.filter(Boolean).join(" · "), props.width)}
    </text>
  )
}

export function PromptBlock(props: { text: string }) {
  return (
    <box
      backgroundColor={theme.band ?? undefined}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={barChars}
      paddingX={2}
      paddingY={1}
    >
      <text fg={theme.text} wrapMode="word">
        {props.text.trim()}
      </text>
    </box>
  )
}

// Opens at the top; once the reader reaches the bottom, new steps keep it there.
export function PageScroll(props: { scrollRef: (scroll: ScrollBoxRenderable) => void; children: JSX.Element }) {
  let following = false
  return (
    <scrollbox
      ref={(element) => {
        props.scrollRef(element)
        const resized = element.content.onSizeChange
        element.content.onSizeChange = () => {
          resized?.()
          if (following) element.scrollTo(element.scrollHeight)
        }
      }}
      renderAfter={function () {
        const bottom = this.scrollHeight - this.viewport.height
        following = bottom > 0 && this.scrollTop >= bottom
      }}
      flexGrow={1}
      marginTop={1}
      paddingRight={1}
      verticalScrollbarOptions={{
        trackOptions: { foregroundColor: theme.muted, backgroundColor: RGBA.fromValues(0, 0, 0, 0) },
      }}
    >
      <box flexDirection="column" gap={1}>
        {props.children}
      </box>
    </scrollbox>
  )
}

function Step(props: { session: Session; item: Item; color: RGBA; width: number }) {
  const tool = (test: (tool: ToolCall) => boolean) =>
    props.item.kind === "tool" && test(props.item) ? props.item : undefined
  return (
    <Switch>
      <Match when={tool(isWorkflowCall)}>
        {(call) => <WorkflowLine session={props.session} tool={call()} color={props.color} width={props.width} />}
      </Match>
      <Match when={tool(isAgentCall)}>
        {(call) => <AgentLine session={props.session} tool={call()} color={props.color} width={props.width} />}
      </Match>
      <Match when={tool(() => true)}>
        {(call) => (
          <ToolCallRow
            item={call()}
            task={props.session.tasks[call().taskId ?? ""]}
            cwd={props.session.info?.cwd ?? ""}
            selected={false}
            expanded={false}
          />
        )}
      </Match>
      <Match when={props.item.kind === "text" ? props.item : undefined}>
        {(text) => <Markdown markdown={text().markdown} streaming={text().streaming} width={props.width} />}
      </Match>
      <Match when={props.item.kind === "thinking" ? props.item : undefined}>
        {(thinking) => <ThinkingRow item={thinking()} />}
      </Match>
    </Switch>
  )
}

export function AgentPage(props: PageProps) {
  const tool = () => {
    const item = props.session.byId[props.node.id]
    return item?.kind === "tool" ? item : undefined
  }
  const agent = () => tool()?.agent ?? null
  const task = () => {
    const id = tool()?.taskId
    const found = id ? props.session.tasks[id] : undefined
    // A resumed agent's task belongs to its newest run, not to the call it first started with.
    return found && (found.toolUseId === null || found.toolUseId === props.node.id) ? found : undefined
  }
  const duration = useDuration(() => props.node)
  const running = () => props.node.state === "running"
  const color = () => agentColor(props.node.colorIndex)
  const inner = () => props.width - 2
  // Kinds never change once a step is added, so only the step count and each thinking block's streaming are tracked.
  // A finished thinking block leaves nothing to draw.
  const steps = createMemo(() => {
    const ids = tool()?.children ?? []
    if (ids.length === 0) return []
    const byId = unwrap(props.session.byId)
    const items = untrack(() =>
      ids.flatMap((id) => {
        const kind = byId[id]?.kind
        const item = props.session.byId[id]
        if (!item || !(kind === "tool" || kind === "text" || kind === "thinking")) return []
        // A quiet step is one the chat leaves out too, such as Claude Code's own handback.
        return "quiet" in item && item.quiet ? [] : [item]
      }),
    )
    return items.filter((item) => byId[item.id]?.kind !== "thinking" || (item.kind === "thinking" && item.streaming))
  })
  const prompt = () => agent()?.prompt || task()?.prompt || ""
  // The tool result wraps a foreground agent's report in a hand-back frame; the notification's summary does not.
  // Claude Code gives a foreground agent's report in its SubagentHandback call, and the result only points there.
  const handback = () => {
    const call = (tool()?.children ?? [])
      .map((id) => props.session.byId[id])
      .find((item) => item?.kind === "tool" && item.name === "SubagentHandback")
    const input = call?.kind === "tool" ? call.input : null
    const message = input && typeof input === "object" && "message" in input ? input.message : undefined
    return typeof message === "string" ? message : ""
  }
  const report = () => {
    const given = (task()?.summary || agent()?.report || "").trim()
    return given.includes("(its SubagentHandback call)") ? handback().trim() || given : given
  }
  const lastText = () => {
    const last = steps().findLast((item) => item.kind === "text")
    return last?.kind === "text" ? last.markdown.trim() : ""
  }
  const outcome = () => {
    // A stopped agent's summary is only its description.
    if (running() || props.node.state === "stopped") return null
    if (props.node.state === "failed")
      return { text: agent()?.error || report() || "failed", color: theme.error, markdown: false }
    const text = report()
    if (!text || text === lastText()) return null
    return { text, color: theme.text, markdown: true }
  }
  const meta = () => [
    agent()?.type ?? "",
    modelName(agent()?.model ?? ""),
    tokens(agent()?.tokens || task()?.tokens || 0),
    `started by ${props.startedBy}`,
  ]

  return (
    <box flexDirection="column" flexGrow={1}>
      <PageHeader
        node={props.node}
        stats={`${count(props.node.toolUses, "tool")} · ${formatDuration(duration())}`}
        right={agent()?.task ?? ""}
        width={props.width}
      />
      <MetaLine parts={meta()} width={props.width} />
      <PageScroll scrollRef={props.scrollRef}>
        <Show when={prompt()}>
          <PromptBlock text={prompt()} />
        </Show>
        <For each={steps()}>
          {(item) => <Step session={props.session} item={item} color={color()} width={inner()} />}
        </For>
        <Show when={running()}>
          <box flexDirection="row" height={1}>
            <AgentMark color={color()} state="running" />
            <text wrapMode="none" fg={theme.muted}>
              {cut(` ${props.node.detail || "working"}… ${formatDuration(duration())}`, inner() - 2)}
            </text>
          </box>
        </Show>
        <Show when={outcome()}>
          {(shown) => (
            <Show when={shown().markdown} fallback={<text fg={shown().color}>{shown().text}</text>}>
              <Markdown markdown={shown().text} streaming={false} width={inner()} />
            </Show>
          )}
        </Show>
      </PageScroll>
    </box>
  )
}
