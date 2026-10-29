// For tests only.
import type { Agent, AgentKind } from "../agent/agent.ts"
import type { Capabilities } from "../agent/capabilities.ts"
import type { AgentEvent } from "../agent/events.ts"

const at = 1000
export const memoryCaps: Capabilities = {
  steer: false,
  queue: false,
  images: false,
  fileSuggestions: false,
  askNote: false,
  ownQuestions: false,
  clientTools: "none",
  mcpServers: "none",
  instructions: false,
  planSignal: "none",
  cut: false,
  fork: false,
  restart: false,
  subagents: false,
  backgroundTasks: false,
  backgroundNow: false,
  stopTask: false,
  taskOutput: false,
  effort: false,
  extraEffort: null,
  thinking: false,
  rename: false,
  titles: "none",
  context: "none",
  usageReport: false,
  limits: false,
  cost: false,
  heldElsewhere: { atOpen: false, live: false },
  lists: [],
  mcp: { toggle: false, reconnect: false, login: false },
  skills: { toggle: false, reload: false },
  plugins: { toggle: false, reload: false },
  settings: false,
  features: [],
}
const refused = () => Promise.resolve({ ok: false as const, problem: "not in memory" })

// A kind that lives in memory, for tests: each prompt gets one reply, and `fail` breaks its stream.
export function memoryKind(id = "memory", name = "Memory", reply = "hello") {
  const queue: AgentEvent[] = []
  let wake: (() => void) | null = null
  let closed = false
  let broken: Error | null = null
  const push = (...events: AgentEvent[]) => {
    queue.push(...events)
    wake?.()
  }
  async function* stream(): AsyncGenerator<AgentEvent> {
    for (;;) {
      const next = queue.shift()
      if (next) yield next
      else if (broken) throw broken
      else if (closed) return
      // oxlint-disable-next-line no-await-in-loop -- waits for the next event
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  }
  const agent: Agent = {
    kind: id,
    session: { agent: id, id: "s1" },
    version: "1",
    caps: memoryCaps,
    events: stream(),
    send(prompt) {
      push(
        {
          type: "user",
          prompt: prompt.id,
          text: prompt.text,
          images: [],
          to: null,
          history: false,
          cutPoint: true,
          at,
        },
        { type: "turn.open", prompts: [prompt.id], endedTasks: [], at },
        { type: "text.start", part: "p1", parent: null, text: reply.slice(0, 3), local: false, quiet: false, at },
        { type: "text.delta", part: "p1", text: reply.slice(3), at },
        { type: "text.end", part: "p1", text: null, at },
        {
          type: "turn.end",
          error: null,
          interrupted: false,
          local: false,
          durationMs: 5,
          inputTokens: 1,
          outputTokens: 1,
          tokens: 2,
          sessionCostUsd: null,
          prompts: [],
          at,
        },
      )
      return Promise.resolve({ ok: true, note: null })
    },
    interrupt: refused,
    answer: () => Promise.resolve(),
    restart: refused,
    close() {
      closed = true
      wake?.()
      return Promise.resolve()
    },
    setMode: refused,
    setModel: refused,
    setEffort: refused,
    setExtraEffort: refused,
    setThinking: refused,
    rename: refused,
    cut: refused,
    undoCut: refused,
    refresh: () => {},
    tasks: { stop: refused, background: refused },
    mcp: { toggle: refused, reconnect: refused, login: refused },
    skills: { toggle: refused, reload: refused },
    plugins: { toggle: refused, reload: refused },
    permissions: { remove: refused },
    settings: { rows: () => Promise.resolve([]), write: refused },
    context: () => Promise.reject(new Error("not in memory")),
    usage: () => Promise.reject(new Error("not in memory")),
    files: () => Promise.resolve([]),
    setClientTools: refused,
    setMcpServers: refused,
  }
  const kind: AgentKind = {
    id,
    name,
    caps: memoryCaps,
    detect: () => Promise.resolve({ installed: true, version: "1", blocked: null, signedIn: null }),
    start: () => {
      push({ type: "ready", at })
      return Promise.resolve(agent)
    },
    sessions: () => Promise.resolve([]),
    history: () => Promise.resolve({ events: [], earlier: null }),
  }
  return {
    kind,
    push,
    fail(error: Error) {
      broken = error
      wake?.()
    },
  }
}
