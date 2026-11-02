import { OWN_AGENTS_SERVER } from "../protocol/messages.ts"
import { z } from "zod"
import type { Agent, ClientTool } from "../agent/agent.ts"
import type { Ask, AskReply } from "../agent/ask.ts"
import type { AgentEvent } from "../agent/events.ts"
import type { AgentKindId, AskId, ModelRef } from "../agent/ids.ts"
import type { ModeKind, ModelRow, ModeRow } from "../agent/lists.ts"
import { subagentMessage } from "../peers/envelope.ts"
import { childAsks, confirmAsk, modelAsk, type ModelChoice, ownAskId, ownAskOf, pickedOf, ranOf } from "./asks.ts"
import { type Child, type ChildResult, createChildren, type Launcher } from "./children.ts"
import type { Definition } from "./definitions.ts"

// The tools reach the user's own session as client tools of this server; children get none.
export const AGENTS_SERVER = OWN_AGENTS_SERVER

export type Provider = { id: AgentKindId; name: string }

export type SubagentDeps = {
  cwd: string
  // The parent's chat, where the asks open.
  parent: { event(event: AgentEvent): void }
  // The added providers.
  providers(): Provider[]
  launcher(provider: AgentKindId): Launcher | null
  // Empty when the provider's modes are not known.
  modes(provider: AgentKindId): Promise<ModeRow[]>
  parentMode(): ModeKind
  // The provider's catalog rows, listed first when the catalog has none.
  models(provider: AgentKindId): Promise<ModelRow[]>
  definitions(): Definition[]
  limit(): number
  // A message for the parent's model, sent as a prompt.
  tell(text: string): void
  close(agent: Agent): Promise<void>
}

export type ToolResult = { text: string; error: boolean }

export const modelText = (ref: ModelRef) => (ref.provider ? `${ref.provider}/${ref.id}` : ref.id)

// The row an agent file's `model:` names.
export const rowOf = (rows: ModelRow[], model: string): ModelRow | undefined =>
  rows.find((row) => modelText(row.ref) === model) ?? rows.find((row) => row.ref.id === model)

// The rows a name the parent's model gave stands for: an id or a label, with or without the inner provider.
export function rowsNamed(rows: ModelRow[], name: string): ModelRow[] {
  const wanted = name.trim().toLowerCase()
  const found = new Map<string, ModelRow>()
  for (const row of rows) {
    const names = [row.ref.id, row.label, modelText(row.ref)]
    if (row.ref.provider) names.push(`${row.ref.provider}/${row.label}`)
    if (names.some((one) => one.toLowerCase() === wanted)) found.set(modelText(row.ref), row)
  }
  return [...found.values()]
}

const ID = { type: "string", description: "The subagent's id, as run returned it." }

export const AGENT_TOOLS = [
  {
    name: "agents",
    description:
      "List the agents `run` can start (name, description, model and provider) and the providers whose models " +
      "`run` can start by name.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "run",
    description:
      "Start a subagent: a session of its own, often another provider's model, that works on `task` while you go " +
      "on. Give `agent` to run one of the agents listed by `agents`, or `model` (a model id or name) to run that " +
      "model with no agent, only your task. It works in the same folder as you, so split the work so that you and " +
      "your subagents never edit the same files. Write the task so it stands alone: the subagent has none of your " +
      "context. This returns at once with the subagent's id, or says the user is asked first. The result (its last " +
      "message, the files it edited and how long it took) arrives later as a message; do not wait or poll for it. " +
      "A finished subagent stays open for `send` until you `close` it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        agent: { type: "string", description: "An agent's name from `agents`." },
        model: { type: "string", description: "A model id or name, used when no agent is given." },
        task: { type: "string" },
      },
    },
  },
  {
    name: "send",
    description:
      "Give an open subagent that finished its last task more work. Its result arrives later as a message; do not " +
      "wait or poll for it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "message"],
      properties: { id: ID, message: { type: "string" } },
    },
  },
  {
    name: "stop",
    description: "Stop a subagent's current task; it stays open. One still waiting for a free slot does not start.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: ID } },
  },
  {
    name: "close",
    description: "Close a subagent you no longer need. A finished subagent stays open until you close it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: ID } },
  },
]

// The tool set is fixed, so an agent that takes tools only at start (Codex) needs no new one for a new agent.
export const agentClientTools = (call: (name: string, input: unknown) => Promise<ToolResult>): ClientTool[] =>
  AGENT_TOOLS.map((tool) => ({
    server: AGENTS_SERVER,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnly: tool.name === "agents", destructive: false },
    run: (input) => call(tool.name, input),
  }))

const RUN = z.object({
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  task: z.string().min(1),
})
const SEND = z.object({ id: z.string().min(1), message: z.string().min(1) })

const error = (text: string): ToolResult => ({ text, error: true })
const done = (text: string): ToolResult => ({ text, error: false })

const LATER = "The result arrives later as a message; do not wait or poll for it."

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const nameOf = (child: Child) => (child.name === "bare" ? modelText(child.model) : child.name)

function resultText(child: Child, result: ChildResult): string {
  const took = duration(result.durationMs)
  const how =
    child.state === "failed"
      ? `Failed after ${took}: ${result.error}`
      : `${result.error === null ? "Finished" : `Ended with an error (${result.error})`} after ${took}. It stays open: ` +
        `send gives it more work, close ends it.`
  return [
    result.text || "(no reply)",
    "",
    `Files edited: ${result.files.length > 0 ? result.files.join(", ") : "none"}`,
    how,
  ].join("\n")
}

type Target = { definition: Definition | null; provider: Provider; row: ModelRow; task: string }
type Begun = { kind: "started"; child: Child } | { kind: "waiting" } | { kind: "failed"; problem: string }

function begunText(begun: Begun, provider: Provider): ToolResult {
  if (begun.kind === "failed") return error(`Did not run: ${begun.problem}.`)
  if (begun.kind === "waiting")
    return done(
      `The user is asked first whether it may run on ${provider.name}; if not, that arrives as a message. ${LATER}`,
    )
  const { child } = begun
  const state = child.state === "queued" ? "is queued until a running subagent finishes" : "is running"
  return done(`${child.id}: ${nameOf(child)} on ${provider.name} ${state}. ${LATER}`)
}

// The subagents of one session of the user's: its tools, the asks they open in its chat, and its children.
export function createSubagents(deps: SubagentDeps) {
  const asks = childAsks(deps.parent)
  const waiting = new Map<string, (reply: AskReply | null) => void>()
  let closed = false

  const tell = (id: string, name: string, provider: string, text: string) => {
    if (!closed) deps.tell(subagentMessage({ id, name, provider, text }))
  }

  function ask(make: (id: string) => Ask): Promise<AskReply | null> {
    const id = crypto.randomUUID()
    deps.parent.event({ type: "ask.open", ask: make(id), at: Date.now() })
    return new Promise((resolve) => waiting.set(id, resolve))
  }

  const children = createChildren({
    limit: () => deps.limit(),
    confirm: (text, task) => ask((id) => confirmAsk(id, text, task)).then((reply) => reply !== null && ranOf(reply)),
    onResult: (child, result) => tell(child.id, nameOf(child), child.provider, resultText(child, result)),
    onChange: (child) => {
      if (child.state === "failed" || child.state === "stopped" || child.state === "closed") asks.end(child.id)
    },
    take: (child, event, launcher) =>
      asks.take(
        {
          id: child.id,
          name: nameOf(child),
          provider: launcher.name,
          agent: { answer: (id, reply) => child.agent?.answer(id, reply) ?? Promise.resolve() },
        },
        event,
      ) && !launcher.keepsAsks,
    close: (agent) => deps.close(agent),
  })

  async function begin({ definition, provider, row, task }: Target): Promise<Begun> {
    const launcher = deps.launcher(provider.id)
    if (!launcher) return { kind: "failed", problem: `${provider.name} cannot run a subagent` }
    const modes = await deps.modes(provider.id)
    if (modes.length === 0)
      return { kind: "failed", problem: `${provider.name} did not say which modes it has, so none can be picked` }
    const name = definition?.name ?? modelText(row.ref)
    return new Promise((resolve) => {
      let asked = false
      void children
        .spawn({
          launcher,
          definition,
          model: row.ref,
          task,
          prompt: task,
          cwd: deps.cwd,
          parentMode: deps.parentMode(),
          modes,
          asking: () => {
            asked = true
            resolve({ kind: "waiting" })
          },
        })
        .then((spawned) => {
          if (!asked)
            resolve(
              spawned.ok ? { kind: "started", child: spawned.child } : { kind: "failed", problem: spawned.problem },
            )
          else if (!spawned.ok) tell("", name, provider.id, `Did not run: ${spawned.problem}.`)
        })
    })
  }

  async function choicesFor(model: string): Promise<ModelChoice[]> {
    const providers = deps.providers()
    const lists = await Promise.all(providers.map((provider) => deps.models(provider.id)))
    return providers.flatMap((provider, index) =>
      rowsNamed(lists[index] ?? [], model).map((row) => ({ provider, row })),
    )
  }

  async function run(input: unknown): Promise<ToolResult> {
    const parsed = RUN.safeParse(input)
    if (!parsed.success) return error(`Invalid input: ${parsed.error.message}`)
    const { agent, model, task } = parsed.data
    if (agent !== undefined) {
      const definition = deps.definitions().find((one) => one.name === agent)
      if (!definition) return error(`There is no agent named ${agent}; agents lists them.`)
      const provider = deps.providers().find((one) => one.id === definition.provider)
      if (!definition.active || !provider || definition.model === null)
        return error(`${agent} has no model on an added provider yet; the user assigns one.`)
      const row = rowOf(await deps.models(provider.id), definition.model)
      if (!row) return error(`${provider.name} no longer lists ${definition.model}.`)
      return begunText(await begin({ definition, provider, row, task }), provider)
    }
    if (model === undefined) return error("Give agent or model.")
    const choices = await choicesFor(model)
    if (choices.length === 0) return error(`No added provider lists a model named ${model}.`)
    // The user's pick both confirms the run and chooses among same-named models.
    void ask((id) => modelAsk(id, model, task, choices)).then(async (reply) => {
      const index = reply === null ? null : pickedOf(reply)
      const choice = index === null ? undefined : choices[index]
      if (!choice) return tell("", model, "yellowcode", "Did not run: the user chose not to run it.")
      const begun = await begin({ definition: null, provider: choice.provider, row: choice.row, task })
      if (begun.kind === "failed") tell("", model, choice.provider.id, `Did not run: ${begun.problem}.`)
    })
    return done(`The user is asked which ${model} runs, if any. ${LATER}`)
  }

  async function agentsText(): Promise<string> {
    const providers = deps.providers()
    await Promise.all(providers.map((provider) => deps.models(provider.id)))
    const definitions = deps.definitions()
    const providerName = (id: string | null) => providers.find((one) => one.id === id)?.name ?? id
    const active = definitions.filter((one) => one.active)
    const inactive = definitions.filter((one) => !one.active).map((one) => one.name)
    return [
      "Agents:",
      ...(active.length > 0
        ? active.map((one) => `- ${one.name}: ${one.description} · ${one.model} · ${providerName(one.provider)}`)
        : ["none"]),
      ...(inactive.length > 0 ? ["", `Without a model until the user assigns one: ${inactive.join(", ")}`] : []),
      "",
      `Providers whose models run takes by name: ${providers.map((one) => one.name).join(", ")}`,
    ].join("\n")
  }

  async function call(name: string, input: unknown): Promise<ToolResult> {
    if (closed) return error("This session is closing.")
    if (name === "agents") return done(await agentsText())
    if (name === "run") return run(input)
    const parsed = SEND.partial({ message: true }).safeParse(input)
    if (!parsed.success) return error(`Invalid input: ${parsed.error.message}`)
    const { id, message } = parsed.data
    if (!children.get(id)) return error(`There is no subagent ${id}.`)
    if (name === "send") {
      if (message === undefined) return error("Give the message.")
      const sent = children.send(id, message)
      return sent.ok ? done(`Sent to ${id}. ${LATER}`) : error(sent.problem)
    }
    if (name === "stop") {
      const stopped = await children.stop(id)
      return stopped.ok ? done(`Stopped ${id}.`) : error(stopped.problem)
    }
    if (name === "close") {
      await children.close(id)
      return done(`Closed ${id}.`)
    }
    return error(`Unknown tool ${name}.`)
  }

  // True when the ask was a subagent's or one of ours about a subagent.
  function answer(requestId: AskId, reply: AskReply): boolean {
    const own = ownAskOf(requestId)
    if (own === null) return asks.answer(requestId, reply)
    const yes = ranOf(reply)
    deps.parent.event({
      type: "ask.close",
      id: requestId,
      outcome: yes ? { status: "allowed" } : { status: "denied", said: "", why: "declined", note: "" },
      at: Date.now(),
    })
    waiting.get(own)?.(reply)
    waiting.delete(own)
    return true
  }

  // The session is replaced, cleared or quit: its subagents and our asks about them go with it.
  function closeAll(): Promise<void> {
    closed = true
    for (const [id, resolve] of waiting) {
      deps.parent.event({ type: "ask.close", id: ownAskId(id), outcome: { status: "cancelled" }, at: Date.now() })
      resolve(null)
    }
    waiting.clear()
    return children.closeAll()
  }

  return { call, answer, closeAll, list: children.list }
}

export type Subagents = ReturnType<typeof createSubagents>
