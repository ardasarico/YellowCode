import type { TaskId, ToolId } from "../../agent/ids.ts"
import type { TaskKind, WorkflowProgress } from "../../agent/events.ts"
import { taskOutput, type ProtocolMessage } from "../../protocol/messages.ts"
import type { Draft } from "./draft.ts"
import type { Tools } from "./tools.ts"

type Of<T extends ProtocolMessage["type"]> = Extract<ProtocolMessage, { type: T }>
type System<S extends Of<"system">["subtype"]> = Extract<Of<"system">, { subtype: S }>

const KINDS = new Map<string, TaskKind>(
  Object.entries({
    local_bash: "shell",
    local_agent: "agent",
    remote_agent: "agent",
    local_workflow: "workflow",
  }),
)

const taskKind = (type: string): TaskKind => KINDS.get(type) ?? "other"

// Claude words a Bash step as "Running " plus its description or command, and a description starts with a verb.
function activityOf(message: System<"task_progress">): string {
  const text = message.description ?? ""
  if (message.last_tool_name !== "Bash" || text === "Running command") return text
  return text.replace(/^Running /, "")
}

function workflowOf(items: NonNullable<System<"task_progress">["workflow_progress"]>): WorkflowProgress {
  const progress: WorkflowProgress = { phases: [], agents: [] }
  for (const item of items) {
    if (item?.type === "workflow_phase") progress.phases.push({ index: item.index, title: item.title })
    else if (item?.type === "workflow_agent")
      progress.agents.push({
        index: item.index,
        label: item.label,
        phaseIndex: item.phaseIndex ?? null,
        phaseTitle: item.phaseTitle ?? null,
        state: item.state,
        prompt: item.promptPreview ?? "",
        model: item.model ?? null,
        toolCalls: item.toolCalls ?? 0,
        tokens: item.tokens ?? 0,
        durationMs: item.durationMs ?? 0,
        startedAt: item.startedAt ?? null,
        lastTool: item.lastToolName ?? null,
        lastToolSummary: item.lastToolSummary ?? null,
        result: item.resultPreview ?? null,
      })
  }
  return progress
}

function progressOf(message: System<"task_progress">): Draft[] {
  const out: Draft[] = [
    {
      type: "task.progress",
      id: message.task_id,
      activity: activityOf(message),
      lastTool: message.last_tool_name ?? null,
      toolUses: message.usage.tool_uses,
      durationMs: message.usage.duration_ms,
      tokens: message.usage.total_tokens ?? null,
    },
  ]
  if (message.workflow_progress)
    out.push({ type: "workflow", task: message.task_id, progress: workflowOf(message.workflow_progress) })
  return out
}

// `call` is the call the task runs under now; a resumed agent's is the SendMessage call that woke it. `agent`: it ran
// under an Agent call or was resumed, so a message to it resumes it.
type Known = { call: ToolId | null; kind: TaskKind; agent: boolean; background: boolean; running: boolean }

// Background tasks as the reducer keeps them, as far as the adapter needs them: which call a resumed agent's lines
// belong to, which tasks are background shells, and which tasks ended before a turn opened.
export function createTasks(tools: Tools) {
  const tasks = new Map<TaskId, Known>()
  // The task each call started or woke.
  const taskOf = new Map<ToolId, TaskId>()
  let live = new Set<TaskId>()
  // Tasks whose end claude reported since the last init, oldest first.
  let ended: TaskId[] = []
  // Our own get_task_output requests: request id → task id.
  const outputs = new Map<string, TaskId>()

  // A resumed agent's lines still name its first Agent call; its run is the SendMessage call's row.
  function current(parent: ToolId | null): ToolId | null {
    const id = parent ? taskOf.get(parent) : undefined
    const task = id === undefined ? undefined : tasks.get(id)
    if (!parent || !task?.call || task.call === parent || !task.running) return parent
    return task.call
  }

  function started(message: System<"task_started">): Draft[] {
    if (message.ambient) return []
    const known = tasks.get(message.task_id)
    const call = message.tool_use_id ?? null
    const callKind = call === null ? undefined : tools.callKind(call)
    const resumed = callKind === "message" && !!known?.agent
    const type = message.task_type ?? ""
    tasks.set(message.task_id, {
      call,
      kind: taskKind(type),
      agent: (known?.agent ?? false) || callKind === "agent" || resumed,
      background: (known?.background ?? false) || message.is_backgrounded === true,
      running: true,
    })
    if (call) taskOf.set(call, message.task_id)
    return [
      {
        type: "task.start",
        id: message.task_id,
        kind: taskKind(type),
        taskType: type,
        call,
        parent: message.parent_task_id ?? null,
        depth: message.spawn_depth ?? null,
        background: message.is_backgrounded === true,
        resumed,
        description: message.description ?? "",
        prompt: message.prompt ?? "",
        workflow: message.workflow_name ?? "",
        agentType: message.subagent_type ?? "",
      },
    ]
  }

  // A background shell's end comes as an update; other tasks end with their notification.
  function updated(message: System<"task_updated">): Draft[] {
    const patch = message.patch
    const out: Draft[] = [
      {
        type: "task.update",
        id: message.task_id,
        error: patch.error || null,
        background: patch.is_backgrounded === true,
      },
    ]
    const task = tasks.get(message.task_id)
    if (!task) return out
    if (patch.is_backgrounded) task.background = true
    const state = patch.status === "killed" ? "stopped" : patch.status
    if (
      task.kind === "shell" &&
      task.background &&
      (state === "completed" || state === "failed" || state === "stopped")
    ) {
      task.running = false
      out.push({ type: "task.end", id: message.task_id, state, report: null, call: null })
    }
    return out
  }

  function notified(message: System<"task_notification">): Draft[] {
    ended.push(message.task_id)
    const task = tasks.get(message.task_id)
    if (task) task.running = false
    const usage = message.usage
    return [
      {
        type: "task.end",
        id: message.task_id,
        state: message.status,
        report: {
          summary: message.summary,
          outputFile: message.output_file ?? null,
          usage: usage
            ? { toolUses: usage.tool_uses, durationMs: usage.duration_ms, tokens: usage.total_tokens ?? null }
            : null,
          stoppedByUser: message.stopped_by_user === true,
        },
        call: message.tool_use_id ?? null,
      },
    ]
  }

  function background(message: System<"background_tasks_changed">): Draft[] {
    const next = new Set<TaskId>()
    const listed = message.tasks.filter((entry) => !entry.ambient)
    for (const entry of listed) {
      next.add(entry.task_id)
      const task = tasks.get(entry.task_id)
      if (task) task.background = true
      else
        tasks.set(entry.task_id, {
          call: null,
          kind: taskKind(entry.task_type ?? ""),
          agent: false,
          background: true,
          running: true,
        })
    }
    for (const id of live) {
      const task = tasks.get(id)
      if (!next.has(id) && task) task.running = false
    }
    live = next
    return [
      {
        type: "tasks.background",
        tasks: listed.map((entry) => ({
          id: entry.task_id,
          kind: taskKind(entry.task_type ?? ""),
          taskType: entry.task_type ?? "",
          description: entry.description ?? "",
          parent: entry.parent_task_id ?? null,
        })),
      },
    ]
  }

  function system(message: Of<"system">): Draft[] | null {
    switch (message.subtype) {
      case "task_started":
        return started(message)
      case "task_progress":
        return progressOf(message)
      case "task_updated":
        return updated(message)
      case "task_notification":
        return notified(message)
      case "background_tasks_changed":
        return background(message)
      // `opened` takes init.
      case "init":
      case "status":
      case "commands_changed":
      case "local_command_output":
      case "session_title_changed":
      case "compact_boundary":
      case "api_retry":
        break
    }
    return null
  }

  function opened(message: System<"init">): Draft {
    const open: Draft = { type: "turn.open", prompts: message.user_message_uuids ?? [], endedTasks: ended }
    ended = []
    return open
  }

  // A call read back from a transcript saw no task start; its result still names the task.
  function results(drafts: Draft[]): Draft[] {
    for (const draft of drafts)
      if (draft.type === "tool.end" && draft.task && !taskOf.has(draft.id)) taskOf.set(draft.id, draft.task)
    return drafts
  }

  function request(message: Of<"control_request">): Draft[] | null {
    const asked = message.request
    if (asked.subtype === "stop_task") return [{ type: "task.stopping", id: asked.task_id }]
    if (asked.subtype === "get_task_output") {
      outputs.set(message.request_id, asked.task_id)
      return []
    }
    return null
  }

  function response(message: Of<"control_response">): Draft[] | null {
    const id = outputs.get(message.response.request_id)
    if (id === undefined) return null
    outputs.delete(message.response.request_id)
    const reply = taskOutput.safeParse(message.response.response)
    if (!reply.success) return []
    const { output, total_bytes, truncated } = reply.data
    return [{ type: "task.output", id, text: output, bytes: total_bytes, truncated }]
  }

  // A /clear drops the tasks that no longer run, as the reducer does.
  function reset(): void {
    for (const [id, task] of tasks) if (!task.running) tasks.delete(id)
    for (const [call, id] of taskOf) if (!tasks.has(id)) taskOf.delete(call)
  }

  function stopRunning(): void {
    for (const task of tasks.values()) task.running = false
  }

  // The new claude numbers its requests from the start again.
  function restart(): void {
    outputs.clear()
  }

  return { current, system, opened, results, request, response, reset, stopRunning, restart }
}

export type Tasks = ReturnType<typeof createTasks>
