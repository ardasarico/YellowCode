// YellowCode's own ask, served to opencode as the MCP server `yellowcode` over its client-mcp socket, and the client
// tools, one socket per `ClientTool.server`. opencode lists client tools in Code Mode's catalog only, so the model
// calls `tools.yellowcode.ask(...)` or `tools["mod-x"].name(...)` from an `execute` call. Every session of the folder
// sees the tools; only a call of our main session opens an ask, and only ours and its subagents' run a client tool.
// The user's answer is the call's result.
import { z } from "zod"
import type { ClientTool } from "../../agent/agent.ts"
import type { Ask, Answers, AskReply } from "../../agent/ask.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { AskId } from "../../agent/ids.ts"
import { log } from "../../log/log.ts"
import { callClientTool, mcpToolEntry } from "../../protocol/mcp-tools.ts"
import { OWN_ASK, ownAskMatrix, ownAskPages } from "../../protocol/messages.ts"
import { NOT_SHOWN, QUESTION_TO_CHAT, SUBAGENT_ASK, TOOL_DECLINED } from "../../protocol/outgoing.ts"
import { ownAskAnswerText, ownAskKeys, withAdditionalNote } from "../../protocol/own-ask-text.ts"
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

const result = (id: RpcId, value: unknown) => ({ jsonrpc: "2.0", id, result: value })
const failure = (id: RpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } })
const text = (id: RpcId, said: string, isError = false) =>
  result(id, { content: [{ type: "text", text: said }], ...(isError ? { isError } : {}) })

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

// The answers as the Claude adapter gives them for its own ask. A page's extra note joins the last question's notes.
function answeredText(
  input: unknown,
  given: Answers,
): { said: string; answers: Record<string, string>; notes: Record<string, string> } {
  const keys = ownAskKeys(input)
  const answered = keys.filter((key) => given.values[key] !== undefined)
  const answers = Object.fromEntries(answered.map((key) => [key, given.values[key]?.join(", ") ?? ""]))
  const typed = Object.fromEntries(Object.entries(given.notes).filter(([, note]) => note !== ""))
  const last = ownAskMatrix.safeParse(input).success ? undefined : keys.at(-1)
  const notes = withAdditionalNote(typed, last, given.note.trim())
  return {
    said: ownAskAnswerText(input, answers, notes),
    answers,
    notes: Object.fromEntries(answered.flatMap((key) => (notes[key] ? [[key, notes[key]]] : []))),
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
  // The event stream connected again: a socket that is down opens again now.
  wake(): void
  close(): void
}

type McpHandlers = {
  capabilities: Record<string, unknown>
  tools(): unknown[]
  call(socket: Socket, id: RpcId, params: unknown): Promise<void>
  cancelled?(socket: Socket, request: RpcId): void
  // The socket closed; the calls it carried are over on opencode's side too.
  closed?(socket: Socket): void
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
    for await (const frame of socket.frames) {
      const message = rpc.safeParse(frame).data
      if (!message) continue
      const { id, method, params } = message
      if (id === undefined) {
        const gone = method === "notifications/cancelled" ? cancelled.safeParse(params).data?.requestId : undefined
        if (gone !== undefined) handlers.cancelled?.(socket, gone)
        continue
      }
      if (method === "initialize") {
        const version = initialize.safeParse(params).data?.protocolVersion ?? PROTOCOL
        socket.send(
          result(id, {
            protocolVersion: version,
            capabilities: handlers.capabilities,
            serverInfo: { name, version: deps.version },
          }),
        )
      } else if (method === "ping") socket.send(result(id, {}))
      else if (method === "tools/list") {
        socket.send(result(id, { tools: handlers.tools() }))
        listed = true
        const done = ready
        void deps.clock.sleep(ATTACH_MS, new AbortController().signal).then(() => done?.())
      } else if (method === "tools/call")
        void handlers
          .call(socket, id, params)
          .catch((error: unknown) => log.error(`opencode: a call to ${name} failed`, error))
      else socket.send(failure(id, -32601, `Method not found: ${method}`))
    }
    handlers.closed?.(socket)
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
  // Open asks by id, with the call each answers.
  const open = new Map<AskId, { handle: RpcId; socket: Socket; input: unknown }>()
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

  async function askCall(socket: Socket, id: RpcId, params: unknown): Promise<void> {
    const parsed = callOf.safeParse(params).data
    if (parsed?.name !== ASK_TOOL.name) return socket.send(failure(id, -32602, `Unknown tool: ${parsed?.name}`))
    const from = callerOf(params)
    if (from !== undefined && from !== deps.session())
      return socket.send(text(id, (await deps.subagent(from)) ? SUBAGENT_ASK : ELSEWHERE, true))
    const input = parsed.arguments
    const problem = ownAskProblem({ toolName: OWN_ASK, input })
    if (problem !== null) return socket.send(text(id, `${NOT_SHOWN}${problem}.`, true))
    const ask = `own_${++asked}`
    open.set(ask, { handle: id, socket, input })
    deps.tell([{ type: "ask.open", ask: ownAsk(ask, id, input), at: deps.at() }])
  }

  const cancelOn = (socket: Socket, handle?: RpcId) => {
    for (const [ask, known] of open)
      if (known.socket === socket && (handle === undefined || known.handle === handle))
        settle(ask, { status: "cancelled" })
  }

  const ask = serveMcp(deps, OWN_SERVER, {
    capabilities: { tools: {} },
    tools: () => [ASK_TOOL],
    call: askCall,
    cancelled: cancelOn,
    closed: (socket) => cancelOn(socket),
  })

  function clientServer(name: string, tools: readonly ClientTool[]): Served {
    const entry: Served = {
      tools,
      server: serveMcp(deps, name, {
        capabilities: { tools: { listChanged: true } },
        tools: () => entry.tools.map(mcpToolEntry),
        async call(socket, id, params) {
          const from = callerOf(params)
          if (from === undefined || (from !== deps.session() && !(await deps.subagent(from))))
            return socket.send(text(id, NOT_OURS, true))
          socket.send(result(id, await callClientTool(entry.tools, params)))
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
        const { said, answers, notes } = answeredText(known.input, reply.answers)
        known.socket.send(text(known.handle, said))
        settle(id, { status: "answered", answers, notes })
        return true
      }
      const chat = reply.type === "declined" && reply.chat
      const said = chat ? QUESTION_TO_CHAT : TOOL_DECLINED
      known.socket.send(text(known.handle, said, true))
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
    wake() {
      for (const server of all()) server.wake()
    },
    close() {
      closed = true
      for (const server of all()) server.close()
    },
  }
}
