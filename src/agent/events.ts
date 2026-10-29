import type { Ask, AskOutcome, Questions } from "./ask.ts"
import type { AskId, EffortId, ModeId, ModelRef, PartId, PromptId, TaskId, ToolId } from "./ids.ts"
import type { LoadedPlugin, Lists, McpServerRow } from "./lists.ts"
import type { FileChange, Hunk, Image, SubagentCall, Todo, ToolKind } from "./tools.ts"

export type SessionInfo = {
  id: string
  model: ModelRef
  mode: ModeId
  cwd: string
  version: string
  // The agent's own tool names; `mcp` names the server of an MCP tool.
  tools: { name: string; mcp: { server: string; tool: string } | null }[]
  mcpServers: McpServerRow[]
  skills: string[]
  commands: string[]
  subagents: string[]
  plugins: LoadedPlugin[]
  // Where the agent's sign-in comes from, by name only (an env variable's name); "none" when it is no key, as with a
  // subscription.
  authSource: string
}

export type TaskKind = "agent" | "shell" | "workflow" | "other"

export type TaskUsage = { toolUses: number; durationMs: number; tokens: number | null }

export type TaskReport = {
  summary: string
  outputFile: string | null
  usage: TaskUsage | null
  // The user stopped it; the agent does not resume such a task.
  stoppedByUser: boolean
  // A shell's; null for other tasks or when the agent did not say.
  exitCode: number | null
}

export type BackgroundTask = {
  id: TaskId
  kind: TaskKind
  taskType: string
  description: string
  parent: TaskId | null
}

// Times are epoch milliseconds on the event's clock.
export type WorkflowProgress = {
  phases: { index: number; title: string }[]
  agents: {
    index: number
    label: string
    phaseIndex: number | null
    phaseTitle: string | null
    state: string
    prompt: string
    model: string | null
    toolCalls: number
    tokens: number
    durationMs: number
    startedAt: number | null
    lastTool: string | null
    lastToolSummary: string | null
    result: string | null
  }[]
}

// A usage window of `minutes`, for one model family or (null) all of them. Times are epoch milliseconds.
export type LimitWindow = { minutes: number; model: string | null; utilization: number; resetsAt: number }

// `status` and `type` are the agent's own words, kept for display; the UI branches on the rest.
export type LimitWarning = {
  reached: boolean
  minutes: number | null
  model: string | null
  resetsAt: number | null
  status: string
  type: string
}

// `parent` is the subagent call an item belongs to; null for the main agent. `quiet` marks a step the agent takes to
// pass something on for the user (feature agentMessages); the chat leaves it out until a `shown` lets it go.
type Events =
  // Lifecycle
  // Each wire line gives at least one event; a line that gives nothing else, in or out, gives this one.
  | { type: "seen" }
  // The agent is started again on the same session; `ready` follows.
  | { type: "starting" }
  // The agent answered for the first time since it started.
  | { type: "ready" }
  // `problem` is null when it went away because YellowCode closed it. `final`: the session itself is gone (deleted
  // elsewhere), so a restart has nothing to go back to.
  | { type: "ended"; problem: { text: string; detail: string[] } | null; final?: true }
  // Another program opened this session, or let it go, while it runs.
  | { type: "held"; elsewhere: boolean }

  // Session
  | { type: "info"; info: SessionInfo }
  | { type: "mode"; mode: ModeId }
  | { type: "model"; model: ModelRef | null }
  | { type: "effort"; effort: EffortId | null }
  // `asked`: the switch is on, though the model may not have it.
  | { type: "extraEffort"; on: boolean; asked: boolean }
  | { type: "title"; title: string }
  // The plan the account is on, such as "Pro".
  | { type: "account"; plan: string | null }
  | { type: "lists"; lists: Partial<Lists> }
  // The agent started the conversation over (a /clear).
  | { type: "reset" }

  // Prompts
  // A prompt reached the agent: YellowCode's own, one from another client, or one read back from history.
  // `prompt` is null when the agent gave it no id; such a prompt never waits. `cutPoint`: the conversation can be cut
  // back to before it.
  | {
      type: "user"
      prompt: PromptId | null
      text: string
      images: Image[]
      to: { task: TaskId; name: string } | null
      history: boolean
      cutPoint: boolean
    }
  // Prompts that waited were taken in.
  | { type: "user.taken"; prompts: PromptId[] }
  // The agent dropped a waiting prompt.
  | { type: "user.dropped"; prompt: PromptId }

  // Turns
  // A turn opens with the prompts it takes in. `endedTasks`: the background tasks whose end the agent reported since
  // the last turn opened, oldest first; a turn without prompts may be the agent's answer to the last of them.
  | { type: "turn.open"; prompts: PromptId[]; endedTasks: TaskId[] }
  // The agent asks its model again within the turn, taking in `prompts`.
  | { type: "turn.step"; prompts: PromptId[] }
  // A model reply began, or arrived whole.
  | { type: "reply" }
  | {
      type: "turn.end"
      // Null when the turn went well.
      error: string | null
      // The agent stopped the turn itself, as an interrupt does.
      interrupted: boolean
      // A command the agent ran without its model; it gets no turn row unless it failed.
      local: boolean
      durationMs: number
      inputTokens: number
      outputTokens: number
      // Every token the turn used, cache reads and writes included.
      tokens: number
      // What the session has cost so far; null for an agent that reports no cost.
      sessionCostUsd: number | null
      // Waiting prompts the turn took in by its end.
      prompts: PromptId[]
    }
  // `asked`: an interrupt went out. `refused`: it failed, so the turn goes on. `answered`: the agent replied to it.
  | { type: "interrupt"; state: "asked" | "refused" | "answered" }

  // Output
  | { type: "text.start"; part: PartId; parent: ToolId | null; text: string; local: boolean; quiet: boolean }
  | { type: "text.delta"; part: PartId; text: string }
  // `text`, when given, replaces what streamed.
  | { type: "text.end"; part: PartId; text: string | null }
  // `live`: it streams now, so it gets a duration; one that came whole has none.
  | { type: "thinking.start"; part: PartId; parent: ToolId | null; text: string; live: boolean }
  | { type: "thinking.delta"; part: PartId; text: string }
  | { type: "thinking.end"; part: PartId; text: string | null }

  // Tools
  | {
      type: "tool.start"
      id: ToolId
      parent: ToolId | null
      // The agent's own name, kept for display and mods.
      name: string
      kind: ToolKind
      // The name the row shows; an MCP tool's own part, `mcp` naming its server.
      title: string
      mcp: { server: string; tool: string } | null
      quiet: boolean
    }
  | { type: "tool.input.delta"; id: ToolId; text: string }
  // The call's whole input is known. Sent again, it updates the call; `kind`, `name`, `title` and `mcp` change it when
  // not null.
  | {
      type: "tool.called"
      id: ToolId
      kind: ToolKind | null
      name: string | null
      title: string | null
      mcp: { server: string; tool: string } | null
      input: unknown
      // One line for the row: a path, a command, a query.
      summary: string
      // What the call says it does, shown while it runs.
      detail: string | null
      // The shell command it runs.
      command: string | null
      // It is meant to run in the background.
      background: boolean
      // The pages of a question call, so the row can show their headers.
      questions: Questions | null
      agent: SubagentCall | null
      // A message to a subagent; the reducer names the subagent in the row.
      message: { to: TaskId; text: string } | null
      todos: Todo[] | null
    }
  // The output so far of a call that streams it; it replaces the last one.
  | { type: "tool.output"; id: ToolId; text: string }
  // The model a subagent call runs on, once the subagent says.
  | { type: "subagent.model"; call: ToolId; model: string }
  | {
      type: "tool.end"
      id: ToolId
      status: "done" | "error" | "stopped"
      result: string
      images: Image[]
      // What the chat shows of a file the call wrote or read; `content` is the text of a file it made.
      patch: Hunk[] | null
      created: boolean
      content: string | null
      unchanged: boolean
      exitCode: number | null
      // What a read or a search came back with.
      count: { n: number; noun: "line" | "file" | "match" } | null
      // How a call that asks the user ended, also when it had no live ask (history, turned down unseen, interrupted).
      outcome: AskOutcome | null
      // The call only launched background work; its outcome comes with the task.
      background: boolean
      // The task the result names as the one the call started.
      task: TaskId | null
      // Files the call wrote, for rewind.
      files: FileChange[]
    }

  // Asks and plans
  | { type: "ask.open"; ask: Ask }
  | { type: "ask.close"; id: AskId; outcome: AskOutcome }
  // A finished plan the agent reports without asking (caps.planSignal "item" or "file"). `next`: the mode to go on in.
  | { type: "plan"; text: string | null; path: string | null; next: ModeId | null }
  // The agent's working plan as steps, outside any tool call.
  | { type: "todos"; items: Todo[] }

  // Background work
  | {
      type: "task.start"
      id: TaskId
      kind: TaskKind
      // The agent's own word for the kind.
      taskType: string
      // The call that started it.
      call: ToolId | null
      parent: TaskId | null
      depth: number | null
      background: boolean
      // A task that ran before goes on under `call`, as a message to a stopped subagent does.
      resumed: boolean
      description: string
      prompt: string
      // The workflow it runs; "" for other tasks.
      workflow: string
      agentType: string
    }
  | {
      type: "task.progress"
      id: TaskId
      // What it does now, in a few words.
      activity: string
      lastTool: string | null
      toolUses: number
      durationMs: number
      tokens: number | null
    }
  | { type: "task.update"; id: TaskId; error: string | null; background: boolean }
  // `call` names the starting call for a task this session never saw start. Every task ends with exactly one
  // `task.end` that has a report; `report: null` says the end is known early and its report follows in a later one.
  | {
      type: "task.end"
      id: TaskId
      state: "completed" | "failed" | "stopped"
      report: TaskReport | null
      call: ToolId | null
    }
  // The user asked to stop it.
  | { type: "task.stopping"; id: TaskId }
  | { type: "task.output"; id: TaskId; text: string; bytes: number; truncated: boolean }
  // Every background task running now; one that leaves the set without an end is gone.
  | { type: "tasks.background"; tasks: BackgroundTask[] }

  // System
  | { type: "context.used"; tokens: number }
  | { type: "context.window"; tokens: number }
  | { type: "limits"; windows: LimitWindow[]; warning: LimitWarning | null }
  | {
      type: "retry"
      attempt: number
      max: number | null
      delayMs: number | null
      status: number | null
      // A category: overloaded, rate_limit, server_error or authentication_failed. Any other text reads as unknown.
      reason: string
    }
  | { type: "compaction"; running: boolean }
  | { type: "compacted"; before: number | null; after: number | null }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  // A line to or from the agent could not be read; `what` names its kind.
  | { type: "unreadable"; what: string }
  // Another client cut the conversation back to before `before`, took its cut back, or made the cut final (the hidden
  // span is gone for good). YellowCode's own cuts show at once through the store and do not come back as these.
  | { type: "cut"; before: PromptId }
  | { type: "cut.undone" }
  | { type: "cut.committed" }

  // Only from agents with the matching feature
  // workflows: a workflow call while its input still streams.
  | { type: "workflow.draft"; call: ToolId; name: string | null; script: string }
  | { type: "workflow"; task: TaskId; progress: WorkflowProgress }
  // agentMessages: a message reached its subagent, or woke it up again.
  | { type: "delivered"; prompt: PromptId; how: "sent" | "resumed" }
  // agentMessages: quiet steps the chat shows after all.
  | { type: "shown"; parts: PartId[]; tools: ToolId[] }

// `at` is epoch milliseconds, when the agent said it; a replay passes the recorded time.
export type AgentEvent = { at: number } & Events

export type AgentEventType = AgentEvent["type"]
