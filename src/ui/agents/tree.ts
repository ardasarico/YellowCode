import { shellNodeId, shellTasks } from "../../session/shells.ts"
import type { Session, TaskState, ToolCall, WorkflowProgress } from "../../session/types.ts"

export type TreeNode = {
  id: string
  kind: "agent" | "workflow" | "phase" | "workflow-agent" | "queued" | "shell"
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

export const isAgentCall = (tool: ToolCall) => tool.agent !== null || tool.name === "Agent"
export const isWorkflowCall = (tool: ToolCall) => tool.name === "Workflow"

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

// The latest phase with a started agent, as `Title done/total`; "" before any agent starts.
function workflowStatus(workflow: WorkflowProgress | null, running: boolean): string {
  if (!workflow) return ""
  for (const phase of workflow.phases.toReversed()) {
    const states = workflow.agents
      .filter((agent) => agent.phaseIndex === phase.index)
      .map((agent) => workflowAgentState(agent, running))
    if (states.some((state) => state !== "queued"))
      return `${phase.title} ${states.filter((state) => state === "completed").length}/${states.length}`
  }
  return ""
}

export function agentNode(
  session: Session,
  tool: ToolCall,
  depth: number,
  parentId: string | null,
  colorIndex: number,
): TreeNode {
  const agent = tool.agent
  const tools = tool.children.filter((id) => session.byId[id]?.kind === "tool").length
  return {
    id: tool.id,
    kind: "agent",
    depth,
    parentId,
    name: agent?.name ?? "agent",
    state: agent?.state ?? toolState(tool.status),
    detail: agent?.activity ?? "",
    toolUses: Math.max(agent?.toolUses ?? 0, tools),
    durationMs: agent?.durationMs ?? 0,
    startedAt: (tool.taskId && session.tasks[tool.taskId]?.startedAt) || null,
    colorIndex,
    selectable: true,
  }
}

export function workflowNode(
  session: Session,
  tool: ToolCall,
  depth: number,
  parentId: string | null,
  colorIndex: number,
): TreeNode {
  const task = tool.taskId ? session.tasks[tool.taskId] : undefined
  const state = task?.state ?? toolState(tool.status)
  const agents = task?.workflow?.agents ?? []
  return {
    id: tool.id,
    kind: "workflow",
    depth,
    parentId,
    name: task?.workflowName || task?.description || "workflow",
    state,
    detail: workflowStatus(task?.workflow ?? null, state === "running"),
    toolUses: agents.length,
    durationMs: task?.durationMs ?? 0,
    startedAt: task?.startedAt ?? null,
    colorIndex,
    selectable: true,
    progress: {
      done: agents.filter((agent) => agent.state === "done").length,
      failed: agents.filter((agent) => agent.state === "error").length,
      total: agents.length,
      tokens: task?.tokens ?? 0,
    },
  }
}

function lastTool(agent: WorkflowAgent): string {
  if (!agent.lastTool) return ""
  return agent.lastToolSummary ? `${agent.lastTool}(${agent.lastToolSummary})` : agent.lastTool
}

function workflowChildren(session: Session, tool: ToolCall, parent: TreeNode): TreeNode[] {
  const workflow = tool.taskId ? session.tasks[tool.taskId]?.workflow : null
  if (!workflow) return []
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
    const agents = workflow.agents
      .filter((agent) => agent.phaseIndex === phase.index)
      .map((agent) => ({ agent, state: workflowAgentState(agent, running) }))
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
    ...tool.children.flatMap((id) => {
      const child = session.byId[id]
      if (child?.kind !== "tool" || !(isAgentCall(child) || isWorkflowCall(child))) return []
      return subtree(session, child, depth + 1, node.id, colorIndex)
    }),
  ]
}

// Pre-order: every top-level agent or workflow followed by its descendants.
export function agentTree(session: Session): TreeNode[] {
  const nodes: TreeNode[] = []
  let order = 0
  for (const id of session.items) {
    const item = session.byId[id]
    if (item?.kind !== "tool" || !(isAgentCall(item) || isWorkflowCall(item))) continue
    nodes.push(...subtree(session, item, 1, null, order))
    order += 1
  }
  return nodes
}

export function shellNodes(session: Session): TreeNode[] {
  return shellTasks(session).map((task) => ({
    id: shellNodeId(task.id),
    kind: "shell",
    depth: 1,
    parentId: null,
    name: task.description || task.command,
    state: task.state,
    detail: task.command,
    toolUses: 0,
    durationMs: task.endedAt !== null && task.startedAt !== null ? task.endedAt - task.startedAt : 0,
    startedAt: task.startedAt,
    colorIndex: 0,
    selectable: true,
  }))
}

// Top-level agents and workflows that are running or started since the latest user message, each followed by its
// descendants, in tree order.
export function activeGroups(session: Session): TreeNode[][] {
  const lastUser = session.items.findLastIndex((id) => session.byId[id]?.kind === "user")
  const recent = new Set(session.items.slice(lastUser + 1))
  const groups: TreeNode[][] = []
  for (const node of agentTree(session)) {
    if (node.depth === 1) groups.push([node])
    else groups.at(-1)?.push(node)
  }
  return groups.filter((group) => group[0]?.state === "running" || recent.has(group[0]?.id ?? ""))
}
