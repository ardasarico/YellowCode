// YellowCode's own ask, served to opencode as the MCP server `yellowcode` over its client-mcp socket, and the client
// tools, one socket per `ClientTool.server`. opencode lists client tools in Code Mode's catalog only, so the model
// calls `tools.yellowcode.ask(...)` or `tools["mod-x"].name(...)` from an `execute` call. Every session of the folder
// sees the tools, and opencode gives each call to the YellowCode that connected last, so a call of a session another
// YellowCode runs is passed on to it (OwnMcpDeps.relay). Only a call of our main session opens an ask, and only ours
// and its subagents' run a client tool. The user's answer is the call's result.
import { z } from "zod"
import type { ClientTool, RelayedCall, RelayedReply } from "../../agent/agent.ts"
import type { Ask, AskReply } from "../../agent/ask.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { AskId } from "../../agent/ids.ts"
import { log } from "../../log/log.ts"
import { callClientTool, mcpToolEntry } from "../../protocol/mcp-tools.ts"
import { OWN_ASK, ownAskMatrix, ownAskPages } from "../../protocol/messages.ts"
import { NOT_SHOWN, QUESTION_TO_CHAT, SUBAGENT_ASK, TOOL_DECLINED } from "../../protocol/outgoing.ts"
import { ownAskAnswered } from "../../protocol/own-ask-text.ts"
import { OWN_ASK_DESCRIPTION, OWN_ASK_SCHEMA } from "../../source/own-ask-tool.ts"
import { ownAskProblem, questionsOf } from "../claude/ask-input.ts"
import type { Clock } from "./sse.ts"
import type { Socket, Transport } from "./transport.ts"

export const OWN_SERVER = "yellowcode"
const PROTOCOL = "2025-11-25"
// No event says opencode took the tools in: a prompt sent 50 ms after the list answer did not see them, 300 ms did.
const ATTACH_MS = 500
// A socket that never lists its tools holds the first prompt no longer than this.
const ATTACH_CAP_MS = 3000
// A socket that listed its tools and closed is opened again after this; any other, when the event stream connects again.
const RETRY_MS = 500

// What a call from another session of the folder gets, such as one of the user's own opencode TUI.
export const ELSEWHERE =
  "This tool asks the user of YellowCode's own session only. Use your own question tool instead, or go on without asking."
export const NOT_OURS = "This tool runs for YellowCode's own session only, so it did not run."

const ASK_TOOL = {
  name: "ask",
  description: OWN_ASK_DESCRIPTION.replaceAll("AskUserQuestion", "the question tool"),
  inputSchema: OWN_ASK_SCHEMA,
  annotations: { readOnlyHint: true },
}

const rpcId = z.union([z.string(), z.number()])
const rpc = z.looseObject({ id: rpcId.optional(), method: z.string(), params: z.unknown().optional() })
const initialize = z.looseObject({ protocolVersion: z.string() })
const callOf = z.looseObject({
  name: z.string(),
  arguments: z.unknown().optional(),
  _meta: z.looseObject({ "ai.opencode/sessionID": z.string().optional() }).optional(),
})
const cancelled = z.looseObject({ requestId: rpcId })

type RpcId = z.output<typeof rpcId>

const respond = (id: RpcId, reply: RelayedReply) => ({ jsonrpc: "2.0", id, ...reply })
const failure = (code: number, message: string): RelayedReply => ({ error: { code, message } })
const text = (said: string, isError = false): RelayedReply => ({
  result: { content: [{ type: "text", text: said }], ...(isError ? { isError } : {}) },
})

function ownAsk(id: AskId, handle: RpcId, input: unknown): Ask {
  const pages = ownAskPages.safeParse(input).data?.questions ?? []
  return {
    id,
    kind: "question",
    call: null,
    tool: { name: `${OWN_SERVER}.ask`, kind: "question", mcp: null },
    title: "ask",
    input,
    target: ownAskMatrix.safeParse(input).data?.matrix.question ?? pages.map((page) => page.header).join(", "),
    preview: null,
    writes: [],
    detail: "",
    reason: "",
    options: [],
    questions: questionsOf(OWN_ASK, input),
    plan: null,
    defaultNo: false,
    safety: false,
    by: null,
    own: { handle },
  }
}

// Whom a tools/call names as its caller; undefined when it names none.
const callerOf = (params: unknown) => callOf.safeParse(params).data?.["_meta"]?.["ai.opencode/sessionID"]

export type OwnMcpDeps = {
  transport(): Transport
  clock: Clock
  // The main session, once there is one.
  session(): string | null
  // Whether `session` is a subagent of our session; a call of a session that is not ours is turned down either way.
  subagent(session: string): Promise<boolean>
  // Passes a call of a session that is not ours on to the YellowCode that runs it; null when none does.
  relay(call: RelayedCall, signal: AbortSignal): Promise<RelayedReply | null>
  // The event stream is down, so the socket waits for it to come back.
  down(): boolean
  version: string
  tell(events: AgentEvent[]): void
  at(): number
}

export type OwnMcp = {
  // Settles once opencode could have taken the tools in from the sockets of the moment, or those did not open.
  attached(): Promise<void>
  // Answers our own ask `id`; false for any other ask.
  answer(id: AskId, reply: AskReply): boolean
  // The client tools from now on: a new server opens its socket, a gone one closes it, a changed one says so.
  setTools(tools: readonly ClientTool[]): void
  // A call another YellowCode passed on: null when its caller is not ours, else `claim` is called and the call runs.
  take(call: RelayedCall, signal: AbortSignal, claim: () => void): Promise<RelayedReply | null>
  // The event stream connected again: a socket that is down opens again now.
  wake(): void
  close(): void
}

type McpHandlers = {
  capabilities: Record<string, unknown>
  tools(): unknown[]
  // `signal` aborts once opencode cancels the call or the socket closes; the reply then goes nowhere.
  call(id: RpcId, params: unknown, signal: AbortSignal): Promise<RelayedReply>
}

type McpServer = {
  attached(): Promise<void>
  // Tells opencode the tools changed; it lists them again.
  changed(): void
  wake(): void
  close(): void
}

// One MCP server on the client-mcp socket `name`, opened again when it drops.
function serveMcp(deps: OwnMcpDeps, name: string, handlers: McpHandlers): McpServer {
  let attach = Promise.resolve()
  let ready: (() => void) | null = null
  let current: Socket | null = null
  let closed = false
  let waking: (() => void) | null = null

  // Each connection, and each change of the tools, holds prompts until opencode could have taken the tools in.
  function attaching(): () => void {
    const done = Promise.withResolvers<void>()
    const cap = setTimeout(done.resolve, ATTACH_CAP_MS)
    attach = done.promise
    ready = () => {
      clearTimeout(cap)
      done.resolve()
    }
    return ready
  }

  // Reads one connection until it closes. Says whether opencode got as far as listing the tools.
  async function serve(socket: Socket): Promise<boolean> {
    let listed = false
    const running = new Map<RpcId, AbortController>()
    for await (const frame of socket.frames) {
      const message = rpc.safeParse(frame).data
      if (!message) continue
      const { id, method, params } = message
      if (id === undefined) {
        const gone = method === "notifications/cancelled" ? cancelled.safeParse(params).data?.requestId : undefined
        if (gone !== undefined) running.get(gone)?.abort()
        continue
      }
      if (method === "initialize") {
        const version = initialize.safeParse(params).data?.protocolVersion ?? PROTOCOL
        socket.send(
          respond(id, {
            result: {
              protocolVersion: version,
              capabilities: handlers.capabilities,
              serverInfo: { name, version: deps.version },
            },
          }),
        )
      } else if (method === "ping") socket.send(respond(id, { result: {} }))
      else if (method === "tools/list") {
        socket.send(respond(id, { result: { tools: handlers.tools() } }))
        listed = true
        const done = ready
        void deps.clock.sleep(ATTACH_MS, new AbortController().signal).then(() => done?.())
      } else if (method === "tools/call") {
        const control = new AbortController()
        running.set(id, control)
        void handlers
          .call(id, params, control.signal)
          .then((reply) => {
            if (!control.signal.aborted) socket.send(respond(id, reply))
          })
          .catch((error: unknown) => log.error(`opencode: a call to ${name} failed`, error))
          .finally(() => {
            if (running.get(id) === control) running.delete(id)
          })
      } else socket.send(respond(id, failure(-32601, `Method not found: ${method}`)))
    }
    for (const control of running.values()) control.abort()
    return listed
  }

  // Resolves after `ms`, or at `wake`; with null only at `wake`.
  function rest(ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === null ? undefined : setTimeout(() => done(), ms)
      const done = () => {
        clearTimeout(timer)
        waking = null
        resolve()
      }
      waking = done
    })
  }

  async function run(): Promise<void> {
    for (;;) {
      attaching()
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      const socket = await deps
        .transport()
        .socket(name)
        .catch(() => null)
      if (closed) return socket?.close()
      let worked = false
      if (socket) {
        current = socket
        // oxlint-disable-next-line no-await-in-loop -- reads the connection until it closes
        worked = await serve(socket)
        current = null
      }
      ready?.()
      if (closed) return
      // oxlint-disable-next-line no-await-in-loop -- waits before the next connection
      await rest(worked && !deps.down() ? RETRY_MS : null)
      if (closed) return
    }
  }

  void run().catch((error: unknown) => {
    log.error(`opencode: the ${name} socket failed`, error)
    ready?.()
  })

  return {
    attached: () => attach,
    changed() {
      if (closed || current === null) return
      attaching()
      current.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
    },
    wake() {
      if (current === null) waking?.()
    },
    close() {
      closed = true
      ready?.()
      current?.close()
      waking?.()
    },
  }
}

type Served = { server: McpServer; tools: readonly ClientTool[] }

const listing = (tools: readonly ClientTool[]) => JSON.stringify(tools.map(mcpToolEntry))

export function startOwnMcp(deps: OwnMcpDeps): OwnMcp {
  // Open asks by id, with how each call gets its answer.
  const open = new Map<AskId, { input: unknown; reply(reply: RelayedReply): void }>()
  let asked = 0
  // The client tools' servers by name.
  const servers = new Map<string, Served>()
  let closed = false
  // A closed socket's tools leave opencode's catalog a moment later, which holds prompts too.
  let leaving = Promise.resolve()

  function settle(id: AskId, outcome: Extract<AgentEvent, { type: "ask.close" }>["outcome"]): void {
    open.delete(id)
    deps.tell([{ type: "ask.close", id, outcome, at: deps.at() }])
  }

  const passOn = (server: string, caller: string, params: unknown, signal: AbortSignal) =>
    deps.relay({ server, caller, params }, signal)

  // `handle` is opencode's id for the call, or the ask's own for one passed on.
  function openAsk(params: unknown, signal: AbortSignal, handle?: RpcId): Promise<RelayedReply> {
    const parsed = callOf.safeParse(params).data
    if (parsed?.name !== ASK_TOOL.name) return Promise.resolve(failure(-32602, `Unknown tool: ${parsed?.name}`))
    const input = parsed.arguments
    const problem = ownAskProblem({ toolName: OWN_ASK, input })
    if (problem !== null) return Promise.resolve(text(`${NOT_SHOWN}${problem}.`, true))
    const id = `own_${++asked}`
    const done = Promise.withResolvers<RelayedReply>()
    open.set(id, { input, reply: done.resolve })
    signal.addEventListener("abort", () => {
      if (!open.has(id)) return
      settle(id, { status: "cancelled" })
      done.resolve(failure(-32800, "Cancelled"))
    })
    deps.tell([{ type: "ask.open", ask: ownAsk(id, handle ?? id, input), at: deps.at() }])
    return done.promise
  }

  async function askCall(handle: RpcId, params: unknown, signal: AbortSignal): Promise<RelayedReply> {
    const from = callerOf(params)
    if (from === undefined || from === deps.session()) return openAsk(params, signal, handle)
    if (await deps.subagent(from)) return text(SUBAGENT_ASK, true)
    return (await passOn(OWN_SERVER, from, params, signal)) ?? text(ELSEWHERE, true)
  }

  const ask = serveMcp(deps, OWN_SERVER, {
    capabilities: { tools: {} },
    tools: () => [ASK_TOOL],
    call: askCall,
  })

  function clientServer(name: string, tools: readonly ClientTool[]): Served {
    const entry: Served = {
      tools,
      server: serveMcp(deps, name, {
        capabilities: { tools: { listChanged: true } },
        tools: () => entry.tools.map(mcpToolEntry),
        async call(_id, params, signal) {
          const from = callerOf(params)
          if (from === undefined) return text(NOT_OURS, true)
          if (from === deps.session() || (await deps.subagent(from)))
            return { result: await callClientTool(entry.tools, params) }
          return (await passOn(name, from, params, signal)) ?? text(NOT_OURS, true)
        },
      }),
    }
    return entry
  }

  const all = () => [ask, ...[...servers.values()].map((entry) => entry.server)]

  return {
    attached: () => Promise.all([leaving, ...all().map((server) => server.attached())]).then(() => {}),
    answer(id, reply) {
      const known = open.get(id)
      if (!known) return false
      if (reply.type === "answers") {
        const { said, answers, notes } = ownAskAnswered(known.input, reply.answers)
        known.reply(text(said))
        settle(id, { status: "answered", answers, notes })
        return true
      }
      const chat = reply.type === "declined" && reply.chat
      const said = chat ? QUESTION_TO_CHAT : TOOL_DECLINED
      known.reply(text(said, true))
      settle(id, { status: "denied", said, why: chat ? "chat" : "declined", note: "" })
      return true
    },
    setTools(tools) {
      if (closed) return
      const wanted = Map.groupBy(tools, (tool) => tool.server)
      for (const [name, known] of servers) {
        if (wanted.has(name)) continue
        known.server.close()
        servers.delete(name)
        leaving = deps.clock.sleep(ATTACH_MS, new AbortController().signal)
      }
      for (const [name, list] of wanted) {
        const known = servers.get(name)
        if (!known) {
          servers.set(name, clientServer(name, list))
          continue
        }
        const changed = listing(known.tools) !== listing(list)
        known.tools = list
        if (changed) known.server.changed()
      }
    },
    async take({ server, caller, params }, signal, claim) {
      if (closed) return null
      const main = caller === deps.session()
      if (!main && !(await deps.subagent(caller))) return null
      if (server === OWN_SERVER) {
        claim()
        return main ? openAsk(params, signal) : text(SUBAGENT_ASK, true)
      }
      const entry = servers.get(server)
      if (!entry) return null
      claim()
      return { result: await callClientTool(entry.tools, params) }
    },
    wake() {
      for (const server of all()) server.wake()
    },
    close() {
      closed = true
      for (const server of all()) server.close()
    },
  }
}
