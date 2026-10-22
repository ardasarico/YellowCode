import { Index, Match, Show, Switch } from "solid-js"
import type { Session } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { AgentMark } from "../figures.tsx"
import { cut, formatDuration, modelName, plain } from "../format.ts"
import { MetaLine, PageHeader, type PageProps, PageScroll, PromptBlock, tokens } from "./agent-page.tsx"
import { count, useDuration } from "./agent-line.tsx"
import { agentColor } from "./tree-rows.tsx"
import type { TreeNode } from "./tree.ts"

function workflowTask(session: Session, toolId: string) {
  const tool = session.byId[toolId]
  const taskId = tool?.kind === "tool" ? tool.taskId : null
  return taskId ? session.tasks[taskId] : undefined
}

function AgentEntry(props: { node: TreeNode; indent: number; width: number }) {
  const duration = useDuration(() => props.node)
  const tail = () => {
    const time = props.node.state === "queued" ? "" : formatDuration(duration())
    return [props.node.detail, time].filter(Boolean).join(" · ")
  }
  const room = () => props.width - props.indent - 2
  const name = () => cut(props.node.name, Math.max(1, room()))
  return (
    <box flexDirection="row" height={1}>
      <text flexShrink={0}>{" ".repeat(props.indent)}</text>
      <AgentMark
        color={agentColor(props.node.colorIndex)}
        state={props.node.state === "queued" ? "running" : props.node.state}
        size="small"
      />
      <text wrapMode="none">
        <span style={{ fg: theme.text }}>{` ${name()}`}</span>
        <span style={{ fg: props.node.state === "running" ? theme.accent : theme.muted }}>
          {tail() ? cut(` · ${tail()}`, Math.max(0, room() - Bun.stringWidth(name()) - 1)) : ""}
        </span>
      </text>
    </box>
  )
}

function Entry(props: { node: TreeNode; depth: number; width: number }) {
  const indent = () => Math.max(0, props.node.depth - props.depth - 1) * 2
  return (
    <Switch>
      <Match when={props.node.kind === "phase"}>
        <text wrapMode="none">
          <span style={{ fg: theme.text, bold: true }}>{" ".repeat(indent()) + plain(props.node.name)}</span>
          <span style={{ fg: theme.muted }}>{` ${props.node.detail}`}</span>
        </text>
      </Match>
      <Match when={props.node.kind === "queued"}>
        <text wrapMode="none" fg={theme.faint}>
          {`${" ".repeat(indent())}○ ${plain(props.node.name)}`}
        </text>
      </Match>
      <Match when={true}>
        <AgentEntry node={props.node} indent={indent()} width={props.width} />
      </Match>
    </Switch>
  )
}

export function WorkflowPage(props: PageProps & { rows: TreeNode[] }) {
  const task = () => workflowTask(props.session, props.node.id)
  const duration = useDuration(() => props.node)
  const agents = () => task()?.workflow?.agents.length ?? 0
  // A stopped workflow's summary is only its description.
  const summary = () =>
    props.node.state === "running" || props.node.state === "stopped" ? "" : (task()?.summary ?? "").trim()
  const description = () => {
    const text = task()?.description ?? ""
    return text === props.node.name ? "" : text
  }
  return (
    <box flexDirection="column" flexGrow={1}>
      <PageHeader
        node={props.node}
        stats={[props.node.detail, formatDuration(duration())].filter(Boolean).join(" · ")}
        right={description()}
        width={props.width}
      />
      <MetaLine
        parts={["workflow", count(agents(), "agent"), tokens(task()?.tokens ?? 0), `started by ${props.startedBy}`]}
        width={props.width}
      />
      <PageScroll scrollRef={props.scrollRef}>
        <box flexDirection="column">
          <Index each={props.rows}>
            {(row) => <Entry node={row()} depth={props.node.depth} width={props.width - 2} />}
          </Index>
        </box>
        <Show when={props.node.state === "failed" && task()?.error}>
          {(error) => <text fg={theme.error}>{error()}</text>}
        </Show>
        <Show when={summary()}>
          <text fg={theme.text}>{summary()}</text>
        </Show>
      </PageScroll>
    </box>
  )
}

export function WorkflowAgentPage(props: PageProps) {
  const agent = () => {
    const split = props.node.id.lastIndexOf(":")
    const index = Number(props.node.id.slice(split + 1))
    return workflowTask(props.session, props.node.id.slice(0, split))?.workflow?.agents.find(
      (entry) => entry.index === index,
    )
  }
  const duration = useDuration(() => props.node)
  const result = () => (props.node.state === "completed" ? (agent()?.result ?? "").trim() : "")
  const meta = () => [
    "workflow agent",
    modelName(agent()?.model ?? ""),
    tokens(agent()?.tokens ?? 0),
    `started by ${props.startedBy}`,
  ]
  return (
    <box flexDirection="column" flexGrow={1}>
      <PageHeader
        node={props.node}
        stats={`${count(props.node.toolUses, "tool")} · ${formatDuration(duration())}`}
        right={agent()?.phaseTitle ?? ""}
        width={props.width}
      />
      <MetaLine parts={meta()} width={props.width} />
      <PageScroll scrollRef={props.scrollRef}>
        <Show when={agent()?.prompt}>{(prompt) => <PromptBlock text={prompt()} />}</Show>
        <Show when={props.node.detail}>
          <text wrapMode="none">
            <span style={{ fg: theme.muted }}>{"Last: "}</span>
            <span style={{ fg: theme.text }}>{cut(props.node.detail, Math.max(1, props.width - 8))}</span>
          </text>
        </Show>
        <Show when={result()}>
          <text fg={theme.text}>{result()}</text>
        </Show>
      </PageScroll>
    </box>
  )
}
