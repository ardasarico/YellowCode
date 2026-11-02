import type { Agent } from "../agent/agent.ts"
import type { Ask, AskOption, AskReply } from "../agent/ask.ts"
import type { AgentEvent } from "../agent/events.ts"
import type { AskId } from "../agent/ids.ts"
import type { ModelRow } from "../agent/lists.ts"
import type { ToolKind } from "../agent/tools.ts"
import { log } from "../log/log.ts"

export type AskingChild = { id: string; name: string; provider: string; agent: Pick<Agent, "answer"> }

type Sink = { event(event: AgentEvent): void }

export const childAskId = (childId: string, askId: AskId): AskId => `child-${childId}-${askId}`

const FILE_KINDS: ReadonlySet<ToolKind> = new Set(["edit", "write", "delete", "move"])

const doing = (ask: Ask): string => {
  if (ask.kind === "question") return "asks"
  if (ask.kind === "plan") return "has a plan"
  if (FILE_KINDS.has(ask.tool.kind)) return `wants to edit ${ask.writes[0] ?? ask.target}`
  if (ask.tool.kind === "shell") return "wants to run a command"
  if (ask.tool.kind === "fetch") return "wants to fetch a page"
  return `wants to use ${ask.tool.name}`
}

// The child's ask as the parent shows it. The options stay the child provider's own, so the answer is the user's.
export const parentCopy = (child: AskingChild, ask: Ask): Ask => ({
  ...ask,
  id: childAskId(child.id, ask.id),
  title: `${child.name} · ${child.provider} ${doing(ask)}`,
  // These name the child's own tool calls, tasks and client tools, none of which the parent store has.
  call: null,
  by: null,
  own: null,
})

// A child's asks are shown and answered in the parent's chat, never in the child's own store.
export function childAsks(parent: Sink) {
  const routes = new Map<AskId, { child: AskingChild; ask: AskId }>()

  const close = (id: AskId, outcome: Extract<AgentEvent, { type: "ask.close" }>["outcome"]) => {
    if (!routes.delete(id)) return
    parent.event({ type: "ask.close", id, outcome, at: Date.now() })
  }

  return {
    // True when the event was the child's ask; it then stays out of the child's store.
    take(child: AskingChild, event: AgentEvent): boolean {
      if (event.type === "ask.open") {
        const copy = parentCopy(child, event.ask)
        routes.set(copy.id, { child, ask: event.ask.id })
        parent.event({ type: "ask.open", ask: copy, at: event.at })
        return true
      }
      if (event.type === "ask.close") {
        close(childAskId(child.id, event.id), event.outcome)
        return true
      }
      return false
    },
    // True when the ask was a child's; the parent's copy closes when the child's ask does.
    answer(id: AskId, reply: AskReply): boolean {
      const route = routes.get(id)
      if (!route) return false
      route.child.agent
        .answer(route.ask, reply)
        .catch((error: unknown) => log.error("cannot answer the subagent's ask", error))
      return true
    },
    // A child that ends or closes takes its open asks with it.
    end(childId: string): void {
      for (const [id, route] of routes) if (route.child.id === childId) close(id, { status: "cancelled" })
    },
  }
}

export type ChildAsks = ReturnType<typeof childAsks>

// YellowCode's own asks on a child's behalf, built like peerAsk.
const OWN = "subagent-"
const DONT = "dont"
const ROW = "row-"

export const ownAskId = (id: string): AskId => `${OWN}${id}`

const option = (id: string, effect: AskOption["effect"], label: string): AskOption => ({
  id,
  effect,
  lasts: "once",
  label,
  subject: null,
  note: false,
  endsTurn: false,
  mode: null,
})

const ownAsk = (id: string, title: string, target: string, options: AskOption[]): Ask => ({
  id: ownAskId(id),
  kind: "permission",
  call: null,
  tool: { name: "subagent", kind: "agent", mcp: null },
  title,
  input: null,
  target,
  preview: null,
  writes: [],
  detail: "",
  reason: "",
  options,
  questions: null,
  plan: null,
  defaultNo: false,
  safety: false,
  by: null,
  own: null,
})

// `text` names the provider and the mode the child would run in.
export const confirmAsk = (id: string, text: string, task: string): Ask =>
  ownAsk(id, text, task, [option("run", "allow", "Run it"), option(DONT, "deny", "Don't run")])

export type ModelChoice = { provider: { id: string; name: string }; row: ModelRow }

// Picking a row both confirms the run and chooses the model.
export const modelAsk = (id: string, model: string, task: string, choices: ModelChoice[]): Ask =>
  ownAsk(id, `Run ${model} for ${task}?`, task, [
    ...choices.map((choice, index) =>
      option(`${ROW}${index}`, "allow", `${choice.row.label} · ${choice.provider.name}`),
    ),
    option(DONT, "deny", "Don't run"),
  ])

// The id an own ask was made with, if it is one of ours.
export const ownAskOf = (askId: AskId): string | null => (askId.startsWith(OWN) ? askId.slice(OWN.length) : null)

export const ranOf = (reply: AskReply): boolean => reply.type === "option" && reply.option !== DONT

// The index into modelAsk's choices; null when the user declined.
export const pickedOf = (reply: AskReply): number | null =>
  reply.type === "option" && reply.option.startsWith(ROW) ? Number(reply.option.slice(ROW.length)) : null
