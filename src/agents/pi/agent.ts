// One pi session on a `pi --mode rpc` of its own, spawned in the session's folder. Commands go to stdin as JSON lines
// and are paired with their responses by id; everything else pi writes is a session event or an extension's request.
import type { Agent, AgentKind, Detection, Prompt, StartOptions } from "../../agent/agent.ts"
import type { AgentEvent, SessionInfo } from "../../agent/events.ts"
import type { ModeId, Outcome, PromptId } from "../../agent/ids.ts"
import type { CommandRow, ListName, ModeRow } from "../../agent/lists.ts"
import { log } from "../../log/log.ts"
import { queue, stdioTransport, type Transport } from "../codex/transport.ts"
import { PI, PI_CAPS, PI_NAME } from "./caps.ts"
import { detect } from "./detect.ts"
import { createTranslator, type Via } from "./translate.ts"
import { clearedQueue, commands, event, promptReply, response, stateOf, type State } from "./wire.ts"

const REQUEST_MS = 60_000
const GONE = { text: "Pi stopped responding", detail: [] }
const DOWN = "Pi is not running"
const IDLE = "Pi is not running a turn"

// Pi asks no approval for any tool; the prompt shows this mode in the warning colors.
export const NO_APPROVALS: ModeRow = {
  id: "no-approvals",
  label: "no approvals",
  description: "Pi runs every tool without asking",
  kind: "bypass",
  cycle: false,
  available: true,
  group: null,
}

export type Deps = {
  detect(): Promise<Detection>
  // A new `pi --mode rpc` in `cwd`, with `args` after it.
  spawn(cwd: string, args: string[]): Transport
}

const realDeps: Deps = {
  detect: () => detect(),
  spawn: (cwd, args) =>
    stdioTransport({
      command: ["pi", "--mode", "rpc", ...args],
      cwd,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      name: "pi",
    }),
}

const now = () => Date.now()
const notYet = (what: string): Outcome => ({ ok: false, problem: `Pi ${what} is not built yet` })
const later = (what: string) => () => Promise.resolve(notYet(what))
const problemOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

type Client = {
  command(type: string, fields?: Record<string, unknown>): Promise<unknown>
  // Answers an extension UI request; pi sends no response to it.
  answer(id: string, reply: Record<string, unknown>): void
  // pi's lines that are not responses, in order. Ends when pi does.
  events: AsyncIterable<unknown>
  close(): Promise<void>
}

function client(transport: Transport): Client {
  let next = 0
  const waiting = new Map<string, { type: string; resolve(data: unknown): void; reject(error: Error): void }>()
  const lines = queue<unknown>()
  void (async () => {
    for await (const raw of transport.messages) {
      const reply = response.safeParse(raw)
      if (!reply.success) {
        lines.push(raw)
        continue
      }
      const id = reply.data.id
      const pending = id === undefined ? undefined : waiting.get(id)
      if (!pending || id === undefined) {
        log.warn("pi: a response to no command", reply.data.command)
        continue
      }
      waiting.delete(id)
      if (reply.data.success) pending.resolve(reply.data.data)
      else pending.reject(new Error(reply.data.error ?? `pi refused ${pending.type}`))
    }
    for (const pending of waiting.values()) pending.reject(new Error(DOWN))
    waiting.clear()
    lines.end()
  })()
  return {
    command(type, fields = {}) {
      const id = `yc-${++next}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error(`pi did not answer ${type}`))
        }, REQUEST_MS)
        waiting.set(id, {
          type,
          resolve: (data) => {
            clearTimeout(timer)
            resolve(data)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        try {
          transport.send({ id, type, ...fields })
        } catch (error) {
          waiting.delete(id)
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    answer(id, reply) {
      transport.send({ type: "extension_ui_response", id, ...reply })
    },
    events: lines.items,
    close: () => transport.close(),
  }
}

function commandRows(data: unknown): CommandRow[] {
  const parsed = commands.safeParse(data)
  if (!parsed.success) return []
  return parsed.data.commands.map((row) => ({
    name: row.name,
    description: row.description ?? "",
    argumentHint: "",
    aliases: [],
    builtin: false,
    setting: null,
    knob: null,
  }))
}

async function usable(deps: Deps): Promise<string> {
  const detected = await deps.detect()
  if (!detected.installed) throw new Error("Pi is not installed")
  return detected.version
}

async function open(deps: Deps, cwd: string, args: string[]): Promise<{ pi: Client; state: State }> {
  const pi = client(deps.spawn(cwd, args))
  try {
    const state = stateOf(await pi.command("get_state"))
    if (!state) throw new Error("Pi gave a state YellowCode cannot read")
    return { pi, state }
  } catch (error) {
    await pi.close()
    throw error
  }
}

// Dialogs come with a later stage; until then each is cancelled, which pi takes as no answer.
const DIALOGS = new Set(["select", "confirm", "input", "editor"])

async function start(options: StartOptions, deps: Deps): Promise<Agent> {
  const version = await usable(deps)
  let { pi, state } = await open(deps, options.cwd, [])
  const session = state.sessionId
  const out = queue<AgentEvent>()
  const translator = createTranslator(options.cwd)
  let ended = false
  let closed = false
  let commandList: CommandRow[] = []
  const tell = (...events: AgentEvent[]) => {
    for (const one of events) out.push(one)
  }

  function request(raw: Record<string, unknown>): AgentEvent[] {
    const id = typeof raw["id"] === "string" ? raw["id"] : null
    const method = raw["method"]
    if (method === "notify") {
      const level = raw["notifyType"] === "error" ? "error" : raw["notifyType"] === "warning" ? "warning" : "info"
      const text = typeof raw["message"] === "string" ? raw["message"] : ""
      return [{ type: "notice", level, text, at: now() }]
    }
    if (id === null || typeof method !== "string" || !DIALOGS.has(method)) return [{ type: "seen", at: now() }]
    pi.answer(id, { cancelled: true })
    const title = typeof raw["title"] === "string" ? `: ${raw["title"]}` : ""
    return [
      {
        type: "notice",
        level: "warning",
        text: `A pi extension asked a question YellowCode cannot show yet${title}`,
        at: now(),
      },
    ]
  }

  async function pump(own: Client): Promise<void> {
    for await (const raw of own.events) {
      if (isRecord(raw) && raw["type"] === "extension_ui_request") {
        tell(...request(raw))
        continue
      }
      const parsed = event.safeParse(raw)
      if (parsed.success) tell(...translator.event(parsed.data, now()))
      else if (isRecord(raw) && typeof raw["type"] === "string") tell({ type: "seen", at: now() })
      else tell({ type: "unreadable", what: "pi", at: now() })
    }
    if (closed || own !== pi) return
    ended = true
    tell(...translator.gone(now()), { type: "ended", problem: GONE, at: now() })
  }

  const follow = (own: Client) =>
    void pump(own).catch((error: unknown) => {
      log.error("pi: the event pump failed", error)
      if (closed || ended || own !== pi) return
      ended = true
      tell({ type: "ended", problem: GONE, at: now() })
    })

  const model = state.model ? { provider: state.model.provider, id: state.model.id } : null
  const info: SessionInfo = {
    id: session,
    model: model ?? { provider: null, id: "" },
    mode: NO_APPROVALS.id,
    cwd: options.cwd,
    version,
    tools: [],
    mcpServers: [],
    skills: [],
    commands: [],
    subagents: [],
    plugins: [],
    authSource: "none",
  }

  async function readCommands(): Promise<void> {
    try {
      commandList = commandRows(await pi.command("get_commands"))
      info.commands = commandList.map((row) => row.name)
      tell({ type: "lists", lists: { commands: commandList }, at: now() })
    } catch (error) {
      log.warn("pi: could not read the commands", problemOf(error))
    }
  }

  tell(
    { type: "ready", at: now() },
    { type: "info", info: { ...info }, at: now() },
    { type: "model", model, at: now() },
    { type: "mode", mode: NO_APPROVALS.id, at: now() },
    { type: "lists", lists: { modes: [NO_APPROVALS] }, at: now() },
  )
  follow(pi)

  async function go(prompt: Prompt, via: Via): Promise<Outcome> {
    translator.sent(prompt.id, prompt.text, via)
    const type = via === "start" ? "prompt" : via === "steer" ? "steer" : "follow_up"
    try {
      const reply = promptReply.safeParse(await pi.command(type, { message: prompt.text }))
      if (reply.success && reply.data.disposition === "handled")
        tell(...translator.handled(prompt.id, prompt.text, now()))
      return { ok: true, note: null }
    } catch (error) {
      translator.forget(prompt.id)
      throw error
    }
  }

  // While a turn runs a prompt is steered into it or queued after it; a turn that ended meanwhile leaves it to start
  // one of its own.
  async function send(prompt: Prompt): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    try {
      if (!translator.running()) return await go(prompt, "start")
      try {
        return await go(prompt, prompt.delivery === "queue" ? "queue" : "steer")
      } catch (error) {
        if (translator.running()) throw error
        return await go(prompt, "start")
      }
    } catch (error) {
      return { ok: false, problem: problemOf(error) }
    }
  }

  // Esc: the queue goes first, so pi does not run it once the turn stops.
  async function interrupt(): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    if (!translator.running()) return { ok: false, problem: IDLE }
    tell({ type: "interrupt", state: "asked", at: now() })
    try {
      const cleared = clearedQueue.safeParse(await pi.command("clear_queue"))
      if (cleared.success) tell(...translator.dropped([...cleared.data.steering, ...cleared.data.followUp], now()))
      await pi.command("abort")
      tell({ type: "interrupt", state: "answered", at: now() })
      return { ok: true, note: null }
    } catch (error) {
      tell({ type: "interrupt", state: "refused", at: now() })
      return { ok: false, problem: problemOf(error) }
    }
  }

  // The same session goes on in a new pi.
  async function restart(): Promise<Outcome> {
    if (!ended || closed) return { ok: false, problem: "Pi is still running" }
    tell({ type: "starting", at: now() })
    try {
      const next = await open(deps, options.cwd, ["--session-id", session])
      pi = next.pi
      state = next.state
      ended = false
      tell({ type: "ready", at: now() })
      follow(pi)
      return { ok: true, note: null }
    } catch (error) {
      const problem = problemOf(error)
      tell({ type: "ended", problem: { text: problem, detail: [] }, at: now() })
      return { ok: false, problem }
    }
  }

  function refresh(list: ListName): void {
    if (list === "commands") void readCommands()
    else if (list === "modes") tell({ type: "lists", lists: { modes: [NO_APPROVALS] }, at: now() })
  }

  const setMode = (mode: ModeId): Promise<Outcome> =>
    Promise.resolve(
      mode === NO_APPROVALS.id ? { ok: true, note: null } : { ok: false, problem: "Pi has no other modes" },
    )

  return {
    kind: PI,
    session: { agent: PI, id: session },
    version,
    caps: PI_CAPS,
    events: out.items,
    send,
    interrupt,
    answer: () => Promise.resolve(),
    restart,
    async close() {
      if (closed) return
      closed = true
      await pi.close()
      tell({ type: "ended", problem: null, at: now() })
      out.end()
    },
    setMode,
    setModel: later("model switching"),
    setEffort: later("thinking levels"),
    setExtraEffort: later("extra effort"),
    setThinking: later("thinking on and off"),
    rename: later("rename"),
    cut: (_before: PromptId) => Promise.resolve(notYet("rewind")),
    undoCut: later("rewind"),
    refresh,
    tasks: { stop: later("tasks"), background: later("background now") },
    mcp: { toggle: later("MCP"), reconnect: later("MCP"), login: later("MCP") },
    skills: { toggle: later("skills"), reload: later("skills") },
    plugins: { toggle: later("plugins"), reload: later("plugins") },
    permissions: { remove: later("permissions") },
    settings: { rows: () => Promise.reject(new Error("Pi settings are not built yet")), write: later("settings") },
    context: () => Promise.reject(new Error("Pi context is not built yet")),
    usage: () => Promise.reject(new Error("Pi usage is not built yet")),
    files: () => Promise.resolve([]),
    setClientTools: later("client tools"),
    setMcpServers: later("MCP servers"),
  }
}

export function piKind(deps: Partial<Deps> = {}): AgentKind {
  const merged = { ...realDeps, ...deps }
  return {
    id: PI,
    name: PI_NAME,
    caps: PI_CAPS,
    detect: () => merged.detect(),
    start: (options) => start(options, merged),
    sessions: () => Promise.resolve([]),
    history: () => Promise.resolve({ events: [], earlier: null }),
  }
}
