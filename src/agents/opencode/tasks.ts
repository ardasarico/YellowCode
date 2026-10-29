// Subagents and shells as tasks. A subagent runs in a child session and a shell runs on its own; opencode links either
// to the call that started it through the call's progress. A task whose call ends while it still runs goes on in the
// background, and its end is reported to the next turn.
import { z } from "zod"
import type { AgentEvent } from "../../agent/events.ts"
import type { TaskId, ToolId } from "../../agent/ids.ts"

type Events = AgentEvent[]
type TaskState = Extract<AgentEvent, { type: "task.end" }>["state"]

type Task = { call: ToolId; background: boolean; stopping: boolean; ended: boolean }

export type Child = Task & {
  id: TaskId
  // The subagent's own task when it runs under another one.
  parent: TaskId | null
  startedAt: number
  toolUses: number
  tokens: number
  // Its last words, which are its report.
  said: string
  // Its model was told.
  model: boolean
}

type Shell = { session: string; command: string; task: Task | null }

type CallInfo = { id: ToolId; input: Record<string, unknown>; background: boolean; resumed: boolean }

const progress = z.looseObject({ sessionID: z.string().optional(), shellID: z.string().optional() })

const text = (input: Record<string, unknown>, key: string) => (typeof input[key] === "string" ? input[key] : "")

export function createTasks() {
  const children = new Map<string, Child>()
  const shells = new Map<string, Shell>()
  // Each task by the call that started it.
  const byCall = new Map<ToolId, TaskId>()
  // Background tasks that ended since the last turn opened.
  let ended: TaskId[] = []

  const taskOf = (id: TaskId): Task | null => children.get(id) ?? shells.get(id)?.task ?? null

  // `open`: a turn runs, and takes the end in itself.
  function end(
    id: TaskId,
    task: Task,
    state: TaskState,
    summary: string,
    child: Child | null,
    at: number,
    open: boolean,
    exitCode: number | null = null,
  ): Events {
    if (task.ended) return []
    task.ended = true
    if (task.background && !open) ended.push(id)
    const usage = child && {
      toolUses: child.toolUses,
      durationMs: Math.max(0, at - child.startedAt),
      tokens: child.tokens,
    }
    const stoppedByUser = task.stopping && state === "stopped"
    const report = { summary, outputFile: null, usage, stoppedByUser, exitCode }
    return [{ type: "task.end", id, state, report, call: task.call, at: 0 }]
  }

  function start(id: TaskId, kind: "agent" | "shell", call: CallInfo, parent: TaskId | null, description: string) {
    byCall.set(call.id, id)
    return {
      type: "task.start" as const,
      id,
      kind,
      taskType: "",
      call: call.id,
      parent,
      depth: null,
      background: call.background,
      resumed: call.resumed,
      description,
      prompt: kind === "agent" ? text(call.input, "prompt") : "",
      workflow: "",
      agentType: kind === "agent" ? text(call.input, "agent") : "",
      at: 0,
    }
  }

  return {
    // The subagent that runs in `session`, if it is one of ours.
    child: (session: string | null) => (session === null ? undefined : children.get(session)),
    // The session a shell runs for.
    shellSession: (id: string) => shells.get(id)?.session ?? null,
    has: (id: TaskId) => taskOf(id) !== null,
    ofCall: (call: ToolId) => byCall.get(call) ?? null,
    // A background shell that ended can still be read.
    background: (id: TaskId) => taskOf(id)?.background ?? false,
    isShell: (id: TaskId) => shells.has(id),
    runningShells: () =>
      [...shells].flatMap(([id, shell]) => (shell.task?.background && !shell.task.ended ? [id] : [])),
    // A shell the agent runs now, its own or a subagent's.
    shellCreated(id: string, session: string, command: string): void {
      if (!shells.has(id)) shells.set(id, { session, command, task: null })
    },

    // A call's progress names the child session or the shell it runs; that starts its task, once.
    linked(call: CallInfo, metadata: unknown, parent: TaskId | null, at: number): Events {
      const found = progress.safeParse(metadata).data
      const shell = found?.shellID === undefined ? undefined : shells.get(found.shellID)
      if (found?.shellID !== undefined && shell && !shell.task) {
        shell.task = { call: call.id, background: call.background, stopping: false, ended: false }
        return [start(found.shellID, "shell", call, parent, shell.command)]
      }
      // A call that goes on with an earlier subagent's session starts its task again.
      if (found?.sessionID === undefined || children.get(found.sessionID)?.call === call.id) return []
      children.set(found.sessionID, {
        id: found.sessionID,
        call: call.id,
        background: call.background,
        stopping: false,
        ended: false,
        parent,
        startedAt: at,
        toolUses: 0,
        tokens: 0,
        said: "",
        model: text(call.input, "model") !== "",
      })
      return [start(found.sessionID, "agent", call, parent, text(call.input, "description"))]
    },

    // A subagent called a tool.
    acted(child: Child, tool: string, activity: string, at: number): Events {
      child.toolUses += 1
      const durationMs = Math.max(0, at - child.startedAt)
      const { toolUses, tokens } = child
      return [{ type: "task.progress", id: child.id, activity, lastTool: tool, toolUses, durationMs, tokens, at: 0 }]
    },

    // The model a subagent runs on, once, when its call did not name one.
    model(child: Child, model: string): Events {
      if (child.model) return []
      child.model = true
      return [{ type: "subagent.model", call: child.call, model, at: 0 }]
    },

    childEnded(child: Child, outcome: "succeeded" | "failed" | "interrupted", at: number, open: boolean): Events {
      const state = outcome === "succeeded" ? "completed" : outcome === "failed" ? "failed" : "stopped"
      return end(child.id, child, state, child.said, child, at, open)
    },

    shellExited(id: string, exit: number | undefined, status: string, open: boolean): Events {
      const task = shells.get(id)?.task
      if (!task) return []
      const state = status === "killed" ? "stopped" : status === "exited" && exit === 0 ? "completed" : "failed"
      return end(id, task, state, "", null, 0, open, exit ?? null)
    },

    // A call that ended in the foreground ends its task, if the task's own end was missed (a resync).
    settled(call: ToolId, state: TaskState, at: number, open: boolean): Events {
      const id = byCall.get(call)
      const task = id === undefined ? null : taskOf(id)
      if (id === undefined || !task || task.background) return []
      const child = children.get(id) ?? null
      return end(id, task, state, child?.said ?? "", child, at, open)
    },

    // The call ended while its task runs on.
    moved(id: TaskId): Events {
      const task = taskOf(id)
      if (!task || task.ended || task.background) return []
      task.background = true
      return [{ type: "task.update", id, error: null, background: true, at: 0 }]
    },

    stopping(id: TaskId): Events {
      const task = taskOf(id)
      if (!task) return []
      task.stopping = true
      return [{ type: "task.stopping", id, at: 0 }]
    },

    // The stop did not go out.
    refused(id: TaskId): void {
      const task = taskOf(id)
      if (task) task.stopping = false
    },

    stopped: (id: TaskId) => taskOf(id)?.stopping ?? false,

    // The background tasks whose end the next turn takes in.
    takeEnded(): TaskId[] {
      const taken = ended
      ended = []
      return taken
    },
  }
}
