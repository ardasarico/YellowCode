import type { Accessor } from "solid-js"
import { unwrap } from "solid-js/store"
import type { Outcome } from "../../agent/ids.ts"
import type { ChildState } from "../../subagents/children.ts"
import type { SessionStore } from "../../session/session.ts"
import { shownItems } from "../../session/rewind.ts"
import { shellNodeId, shellTasks } from "../../session/shells.ts"
import type { ItemId, Session, Task, TaskState, ToolCall, WorkflowProgress } from "../../session/types.ts"
import { workflowPlan } from "../../session/workflow-script.ts"
import { plain } from "../format.ts"

export type TreeNode = {
  id: string
  kind: "agent" | "workflow" | "phase" | "workflow-agent" | "queued" | "shell" | "child"
  depth: number
  parentId: string | null
  name: string
  state: TaskState | "queued"
  // An agent's activity, a workflow's phase progress, a workflow agent's last tool or a phase's `done/total`.
  detail: string
  toolUses: number
  durationMs: number
  startedAt: number | null
  colorIndex: number
  selectable: boolean
  progress?: WorkflowBar
  // A failed agent's error, from its task or its error result.
  error?: string
  // How many lines of its script claude has written so far, while the workflow call is still being written.
  scriptLines?: number
}

type WorkflowBar = { done: number; failed: number; total: number; tokens: number }

const BAR_SIZES = [20, 12, 8]
const BAR_GAPS = 4

// The widest bar that fits in `room` columns with a two-space gap on each side, or 0 for none.
export function barSize(room: number): number {
  return BAR_SIZES.find((size) => size + BAR_GAPS <= room) ?? 0
}

export function barCells(bar: WorkflowBar, size: number): { done: number; failed: number; empty: number } {
  if (bar.total === 0) return { done: 0, failed: 0, empty: size }
  const done = Math.round((bar.done / bar.total) * size)
  const failed = Math.round(((bar.done + bar.failed) / bar.total) * size) - done
  return { done, failed, empty: size - done - failed }
}

type WorkflowAgent = WorkflowProgress["agents"][number]

export const isAgentCall = (tool: ToolCall) => tool.agent !== null || tool.toolKind === "agent"
export const isWorkflowCall = (tool: ToolCall) => tool.toolKind === "workflow"

function toolState(status: ToolCall["status"]): TaskState {
  if (status === "done") return "completed"
  if (status === "error") return "failed"
  return status
}

function workflowAgentState(agent: WorkflowAgent, workflowRunning: boolean): TreeNode["state"] {
  if (agent.state === "done") return "completed"
  if (agent.state === "error") return "failed"
  if (agent.state === "start" && agent.startedAt === null) return "queued"
  return workflowRunning ? "running" : "stopped"
}

// Each progress report replaces the snapshot whole, so its insides are read untracked.
function snapshot(task: Task | undefined): WorkflowProgress | null {
  return task?.workflow ? unwrap(task.workflow) : null
}

function byPhase(workflow: WorkflowProgress): Map<number | null, WorkflowAgent[]> {
  const groups = new Map<number | null, WorkflowAgent[]>()
  for (const agent of workflow.agents) {
    const group = groups.get(agent.phaseIndex)
    if (group) group.push(agent)
    else groups.set(agent.phaseIndex, [agent])
  }
  return groups
}

function workflowStatus(workflow: WorkflowProgress | null, running: boolean): string {
  if (!workflow) return ""
  const groups = byPhase(workflow)
  for (const phase of workflow.phases.toReversed()) {
    const states = (groups.get(phase.index) ?? []).map((agent) => workflowAgentState(agent, running))
    if (states.some((state) => state !== "queued"))
      return `${phase.title} ${states.filter((state) => state === "completed").length}/${states.length}`
  }
  return ""
}

// A finished task took at least from its start to its end, so its time never drops below the count-up it showed.
function finishedMs(task: Task | undefined, reported: number): number {
  if (!task || task.state === "running" || task.endedAt === null || task.startedAt === null) return reported
  return Math.max(reported, task.endedAt - task.startedAt)
}

export function agentNode(
  session: Session,
  tool: ToolCall,
  depth: number,
  parentId: string | null,
  colorIndex: number,
): TreeNode {
  const agent = tool.agent
  const found = tool.taskId ? session.tasks[tool.taskId] : undefined
  const task = found && (found.toolUseId === null || found.toolUseId === tool.id) ? found : undefined
  const byId = unwrap(session.byId)
  const tools = tool.children.length === 0 ? 0 : unwrap(tool.children).filter((id) => byId[id]?.kind === "tool").length
  return {
    id: tool.id,
    kind: "agent",
    depth,
    parentId,
    name: agent?.name ?? "agent",
    state: agent?.state ?? toolState(tool.status),
    detail: agent?.activity ?? "",
    toolUses: Math.max(agent?.toolUses ?? 0, tools),
    durationMs: finishedMs(task, agent?.durationMs ?? 0),
    startedAt: task?.startedAt || null,
    colorIndex,
    selectable: true,
    error: agent?.error || task?.error || (agent?.state === "failed" ? agent.report : "") || undefined,
  }
}

// The script so far while claude is still writing the call, with the JSON escapes undone loosely.
function draftScript(inputText: string): string {
  const start = /"script"\s*:\s*"/.exec(inputText)
  if (!start) return ""
  return inputText
    .slice(start.index + start[0].length)
    .replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char))
}

const writing = (tool: ToolCall) => tool.status === "running" && tool.input === undefined

export function workflowNode(
  session: Session,
  tool: ToolCall,
  depth: number,
  parentId: string | null,
  colorIndex: number,
): TreeNode {
  const task = tool.taskId ? session.tasks[tool.taskId] : undefined
  const state = task?.state ?? toolState(tool.status)
  const workflow = snapshot(task)
  const agents = workflow?.agents ?? []
  const script = !task && writing(tool) ? draftScript(tool.inputText) : null
  return {
    id: tool.id,
    kind: "workflow",
    depth,
    parentId,
    name: task?.workflowName || task?.description || workflowPlan(tool.input ?? { script })?.name || "workflow",
    state,
    detail: workflowStatus(workflow, state === "running"),
    toolUses: agents.length,
    durationMs: finishedMs(task, task?.durationMs ?? 0),
    startedAt: task?.startedAt ?? null,
    colorIndex,
    selectable: true,
    progress: {
      done: agents.filter((agent) => agent.state === "done").length,
      failed: agents.filter((agent) => agent.state === "error").length,
      total: agents.length,
      tokens: task?.tokens ?? 0,
    },
    scriptLines: script === null ? undefined : script ? script.split("\n").length : 0,
  }
}

function lastTool(agent: WorkflowAgent): string {
  if (!agent.lastTool) return ""
  return agent.lastToolSummary ? `${agent.lastTool}(${agent.lastToolSummary})` : agent.lastTool
}

function workflowChildren(session: Session, tool: ToolCall, parent: TreeNode): TreeNode[] {
  const workflow = snapshot(tool.taskId ? session.tasks[tool.taskId] : undefined)
  if (!workflow) return []
  const groups = byPhase(workflow)
  const running = parent.state === "running"
  const agentRow = (agent: WorkflowAgent, depth: number, parentId: string, state: TreeNode["state"]): TreeNode => ({
    id: `${tool.id}:${agent.index}`,
    kind: "workflow-agent",
    depth,
    parentId,
    name: agent.label,
    state,
    detail: lastTool(agent),
    toolUses: agent.toolCalls,
    durationMs: agent.durationMs,
    startedAt: agent.startedAt,
    colorIndex: parent.colorIndex,
    selectable: true,
  })
  const phaseIndexes = new Set(workflow.phases.map((phase) => phase.index))
  const nodes = workflow.agents
    .filter((agent) => agent.phaseIndex === null || !phaseIndexes.has(agent.phaseIndex))
    .map((agent) => agentRow(agent, parent.depth + 1, parent.id, workflowAgentState(agent, running)))

  for (const phase of workflow.phases) {
    const agents = (groups.get(phase.index) ?? []).map((agent) => ({
      agent,
      state: workflowAgentState(agent, running),
    }))
    const id = `${tool.id}:phase:${phase.index}`
    const count = (state: TreeNode["state"]) => agents.filter((entry) => entry.state === state).length
    const queued = count("queued")
    const completed = count("completed")
    nodes.push({
      id,
      kind: "phase",
      depth: parent.depth + 1,
      parentId: parent.id,
      name: phase.title,
      state:
        count("running") > 0
          ? "running"
          : queued === agents.length
            ? "queued"
            : count("stopped") > 0
              ? "stopped"
              : queued > 0
                ? running
                  ? "running"
                  : "stopped"
                : completed === 0
                  ? "failed"
                  : "completed",
      detail: `${completed}/${agents.length}`,
      toolUses: 0,
      durationMs: 0,
      startedAt: null,
      colorIndex: parent.colorIndex,
      selectable: false,
    })
    for (const { agent, state } of agents)
      if (state !== "queued") nodes.push(agentRow(agent, parent.depth + 2, id, state))
    if (queued > 0)
      nodes.push({
        id: `${tool.id}:queued:${phase.index}`,
        kind: "queued",
        depth: parent.depth + 2,
        parentId: id,
        name: `${queued} agent${queued === 1 ? "" : "s"} queued`,
        state: "queued",
        detail: "",
        toolUses: 0,
        durationMs: 0,
        startedAt: null,
        colorIndex: parent.colorIndex,
        selectable: false,
      })
  }
  return nodes
}

function subtree(
  session: Session,
  tool: ToolCall,
  depth: number,
  parentId: string | null,
  colorIndex: number,
): TreeNode[] {
  if (isWorkflowCall(tool)) {
    const node = workflowNode(session, tool, depth, parentId, colorIndex)
    return [node, ...workflowChildren(session, tool, node)]
  }
  const node = agentNode(session, tool, depth, parentId, colorIndex)
  return [
    node,
    ...agentCalls(session, tool.children).flatMap((child) => subtree(session, child, depth + 1, node.id, colorIndex)),
  ]
}

// The agent and workflow calls among `ids`. An item's kind and name never change once it is added, so only how many
// ids there are is tracked.
function agentCalls(session: Session, ids: ItemId[]): ToolCall[] {
  if (ids.length === 0) return []
  const byId = unwrap(session.byId)
  const calls: ToolCall[] = []
  for (const id of unwrap(ids)) {
    const raw = byId[id]
    if (raw?.kind !== "tool" || !(isAgentCall(raw) || isWorkflowCall(raw))) continue
    const tool = session.byId[id]
    if (tool?.kind === "tool") calls.push(tool)
  }
  return calls
}

// An agent's inner agents and workflows at every depth, in tree order, with the agent itself at depth 1.
export function innerNodes(session: Session, tool: ToolCall, colorIndex: number): TreeNode[] {
  return subtree(session, tool, 1, null, colorIndex)
    .slice(1)
    .filter((node) => node.kind === "agent" || node.kind === "workflow")
}

// Agents a /clear carried over come first.
const topCalls = (session: Session) => [
  ...agentCalls(session, session.carried),
  ...agentCalls(session, shownItems(session.items, session.rewound)),
]

// Pre-order: every top-level agent or workflow followed by its descendants.
export function agentTree(session: Session): TreeNode[] {
  return topCalls(session).flatMap((tool, order) => subtree(session, tool, 1, null, order))
}

export function topNodes(session: Session): TreeNode[] {
  return topCalls(session).map((tool, order) =>
    isWorkflowCall(tool) ? workflowNode(session, tool, 1, null, order) : agentNode(session, tool, 1, null, order),
  )
}

export function shellNodes(session: Session): TreeNode[] {
  return shellTasks(session).map((task) => ({
    id: shellNodeId(task.id),
    kind: "shell",
    depth: 1,
    parentId: null,
    name: plain(task.description || task.command),
    state: task.state,
    detail: task.command,
    toolUses: 0,
    durationMs: task.endedAt !== null && task.startedAt !== null ? task.endedAt - task.startedAt : 0,
    startedAt: task.startedAt,
    colorIndex: 0,
    selectable: true,
  }))
}

// A subagent YellowCode runs for the session, as the UI shows it. `name` is the agent's, or the model's for a bare
// run; `provider` is the provider's name.
export type ChildView = {
  id: string
  name: string
  provider: string
  providerId: string
  model: string
  state: Exclude<ChildState, "closed">
  startedAt: number | null
  endedAt: number | null
  problem: string | null
  store: SessionStore
}

const CHILD_PREFIX = "child:"
export const childNodeId = (id: string) => `${CHILD_PREFIX}${id}`
export const childIdOf = (node: TreeNode): string | null =>
  node.kind === "child" ? node.id.slice(CHILD_PREFIX.length) : null

// What the user can do to a child from the panel and the agent view.
export type ChildActions = {
  list: Accessor<ChildView[]>
  send(id: string, text: string): Outcome
  stop(id: string): Promise<Outcome>
  close(id: string): Promise<void>
}

// A child takes a message while it runs or waits for more; it can close once it stopped running.
export const childTakes = (node: TreeNode) => node.state === "running" || node.state === "completed"
export const childCloses = (node: TreeNode) => node.state !== "running" && node.state !== "queued"

// An idle child is done with its task and stays open for more.
const CHILD_STATES: Record<ChildView["state"], TreeNode["state"]> = {
  queued: "queued",
  running: "running",
  idle: "completed",
  failed: "failed",
  stopped: "stopped",
}

// `first` is the colour of the first child, after the session's own agents.
export function childNodes(children: ChildView[], first = 0): TreeNode[] {
  return children.map((child, index) => ({
    id: childNodeId(child.id),
    kind: "child",
    depth: 1,
    parentId: null,
    name: child.name,
    state: CHILD_STATES[child.state],
    detail: child.provider,
    toolUses: 0,
    durationMs: child.startedAt !== null && child.endedAt !== null ? child.endedAt - child.startedAt : 0,
    startedAt: child.startedAt,
    colorIndex: first + index,
    selectable: true,
    error: child.problem ?? undefined,
  }))
}

// The task a node stands for: a shell's own, an agent's or workflow's through its call. The rows inside a workflow
// have none.
export function taskIdOf(session: Session, node: TreeNode): string | null {
  if (node.kind === "shell") return node.id.slice(shellNodeId("").length)
  if (node.kind !== "agent" && node.kind !== "workflow") return null
  const tool = session.byId[node.id]
  return tool?.kind === "tool" ? tool.taskId : null
}

// The agents stopping a running workflow ends: those running and those still queued.
export function liveAgentCount(session: Session, node: TreeNode): number {
  const tool = session.byId[node.id]
  const workflow =
    node.kind === "workflow" && tool?.kind === "tool"
      ? snapshot(tool.taskId ? session.tasks[tool.taskId] : undefined)
      : null
  return workflow?.agents.filter((agent) => agent.state === "start").length ?? 0
}

// Top-level agents and workflows that are running or started since the latest user message, in tree order.
export function activeNodes(session: Session): TreeNode[] {
  const nodes = topNodes(session)
  const byId = unwrap(session.byId)
  const shown = shownItems(unwrap(session.items), session.rewound)
  const lastUser = shown.findLastIndex((id) => byId[id]?.kind === "user")
  const recent = new Set(shown.slice(lastUser + 1))
  // A call the agent is still writing, or a workflow waiting to start, keeps its progress in its chat row.
  const started = (node: TreeNode) => {
    if (node.kind === "workflow") return node.startedAt !== null
    const tool = session.byId[node.id]
    return tool?.kind !== "tool" || !writing(tool)
  }
  return nodes.filter((node) => (node.state === "running" || recent.has(node.id)) && started(node))
}

// claude refuses to resume an agent the user stopped, so only top-level agents that ran or failed take messages.
export function messageable(session: Session, node: TreeNode): boolean {
  const tool = session.byId[node.id]
  const stoppedByUser = tool?.kind === "tool" && tool.agent?.stoppedByUser === true
  return node.kind === "agent" && node.depth === 1 && !stoppedByUser && taskIdOf(session, node) !== null
}
