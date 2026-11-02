// Scenario steps that drive the opencode adapter itself: the recorder runs them on the live service, tests and
// --check run them on a replay of the fixture.
import type { ClientTool, ContextReport, Prompt, PromptImage, StartOptions } from "../../src/agent/agent.ts"
import type { AskReply } from "../../src/agent/ask.ts"
import type { AgentEvent, AgentEventType } from "../../src/agent/events.ts"
import type { AskId, EffortId, ModeId, ModelRef, Outcome, PromptId } from "../../src/agent/ids.ts"
import type { ListName } from "../../src/agent/lists.ts"
import type { SettingRow, SettingValue } from "../../src/agent/settings.ts"
import type { HistoryCursor, HistoryPage, SessionEntry } from "../../src/agent/sessions.ts"
import { opencodeKind, startOpencode, type Deps, type OpencodeAgent } from "../../src/agents/opencode/agent.ts"
import { OPENCODE } from "../../src/agents/opencode/caps.ts"
import type { Fixture } from "../../src/agents/opencode/fixture.ts"
import { replayTransport, type ReplayTransport } from "../../src/agents/opencode/replay-transport.ts"
import type { Clock } from "../../src/agents/opencode/sse.ts"
import type { Method, Reply, Transport } from "../../src/agents/opencode/transport.ts"
import { commandOf } from "../../src/input/commands.ts"
import { showEarly } from "../../src/session/follow.ts"
import { hiddenPrompts } from "../../src/session/rewind.ts"
import type { SessionStore } from "../../src/session/session.ts"
import { follow, type Follower } from "./driver.ts"

export type AgentDriver = {
  directory: string
  // Starts the agent, on a session of its own or an earlier one; a running agent is closed first.
  start(resume?: StartOptions["resume"]): Promise<void>
  // The kind's own reads, outside a running agent. What they give is kept in `outputs`.
  sessions(): Promise<SessionEntry[]>
  history(id: string, cursor?: HistoryCursor | null): Promise<HistoryPage>
  // What /context shows, kept in `outputs`.
  context(): Promise<ContextReport>
  // The rows /settings shows, kept in `outputs`, and a write of one.
  settings(): Promise<SettingRow[]>
  writeSetting(id: string, value: SettingValue): Promise<Outcome>
  // As the app sends: a pending cut goes in first, then the prompt shows. Text that names a command the agent listed
  // runs it.
  send(text: string, images?: PromptImage[], delivery?: Prompt["delivery"]): Promise<Outcome>
  // A rewind that keeps the files, as the app makes one: the store hides the span, the agent cuts. Its redo.
  cut(before: PromptId): Promise<Outcome>
  undoCut(): Promise<Outcome>
  interrupt(): Promise<Outcome>
  setMode(mode: ModeId): Promise<Outcome>
  setModel(model: ModelRef): Promise<Outcome>
  setEffort(effort: EffortId | null): Promise<Outcome>
  rename(title: string): Promise<Outcome>
  // The next neutral event of `type` (that `match` accepts) after the last one an `until` returned.
  until<T extends AgentEventType>(
    type: T,
    match?: (event: Extract<AgentEvent, { type: T }>) => boolean,
    timeoutMs?: number,
  ): Promise<Extract<AgentEvent, { type: T }>>
  answer(ask: AskId, reply: AskReply): Promise<void>
  // Ctrl+B, and a task's stop.
  background(): Promise<Outcome>
  stop(task: string): Promise<Outcome>
  refresh(list: ListName): void
  removeRule(id: string): Promise<Outcome>
  // The MCP tab's actions.
  toggleMcp(name: string, on: boolean): Promise<Outcome>
  reconnectMcp(name: string): Promise<Outcome>
  // The prompt's @ suggestions, kept in `outputs`.
  files(query: string): Promise<string[]>
  // The client tools of the next start, and of the running agent from now on.
  setClientTools(tools: ClientTool[]): Promise<Outcome>
  // A request of the scenario's own, past the adapter, on the adapter's transport.
  http(method: Method, path: string, body?: unknown): Promise<Reply>
  // Live, the event stream is cut; either way this waits until the adapter is connected again and has resynced.
  reconnect(): Promise<void>
  // Gives the live service time where no event of this session says it is done. A replay waits only for the events
  // recorded during it.
  pause(ms: number): Promise<void>
  session(): string
  close(): Promise<void>
}

// What the kind's own reads gave, in the order the scenario made them.
export type DriverOutput =
  | { sessions: SessionEntry[] }
  | { history: HistoryPage }
  | { context: ContextReport }
  | { settings: SettingRow[] }
  | { files: string[] }

export type AgentDriverOptions = {
  directory: string
  deps: Partial<Deps>
  // Cuts the adapter's event stream; live only.
  cut?: () => void
  live?: boolean
  // Fed every event, with each prompt shown at Enter first, as the app does.
  store?: SessionStore
  onIntent?: (intent: string, args: unknown) => void
  // A replay's wait for the events recorded before intent `n`.
  settled?: (n: number) => Promise<void>
  timeoutMs?: number
}

const START: Omit<StartOptions, "cwd"> = {
  resume: null,
  mode: null,
  defaultMode: null,
  model: null,
  effort: null,
  extraEffort: false,
  ephemeral: false,
  plain: false,
  thinking: false,
  instructions: [],
  clientTools: [],
  mcpServers: [],
}

export function createAgentDriver(
  options: AgentDriverOptions,
): AgentDriver & { events: AgentEvent[]; outputs: DriverOutput[] } {
  const timeout = options.timeoutMs ?? 30_000
  const events: AgentEvent[] = []
  const outputs: DriverOutput[] = []
  let transport: Transport | null = null
  let agent: OpencodeAgent | null = null
  let follower: Follower<AgentEvent> | null = null
  let reconnects = 0
  let prompts = 0
  let clientTools: ClientTool[] = []
  // Numbered as the recorder numbers them.
  let intents = 0
  const intent = (name: string, args: unknown = {}) => {
    intents += 1
    options.onIntent?.(name, args)
  }
  // The commands the agent listed last, which a sent text may name.
  const lastCommands = () => {
    for (const event of events.toReversed())
      if (event.type === "lists" && event.lists.commands) return event.lists.commands
    return []
  }
  const running = () => {
    if (!agent || !follower) throw new Error("the scenario has not started the agent")
    return { agent, follower }
  }
  const make = options.deps.transport
  const deps: Partial<Deps> = {
    ...options.deps,
    transport(endpoint, directory) {
      if (!make) throw new Error("the driver needs a transport")
      transport = make(endpoint, directory)
      return transport
    },
  }
  const kind = opencodeKind(deps)

  return {
    directory: options.directory,
    events,
    outputs,
    async start(resume = null) {
      intent("start", resume ? { resume } : {})
      await agent?.close()
      agent = await startOpencode({ ...START, cwd: options.directory, resume, clientTools }, deps)
      follower = follow<AgentEvent, AgentEvent>(
        agent.events,
        (event) => {
          events.push(event)
          options.store?.event(event)
          return event
        },
        "agent's events",
      )
    },
    send(text, images = [], delivery = "steer") {
      intent("send", {
        text,
        ...(images.length > 0 ? { images: images.length } : {}),
        ...(delivery === "queue" ? { delivery } : {}),
      })
      const prompt: Prompt = {
        id: `prompt-${++prompts}`,
        text,
        images,
        command: commandOf(text, lastCommands()),
        to: null,
        delivery,
        kept: [],
        context: null,
        shells: [],
      }
      const { store } = options
      const live = running().agent
      const out = () => {
        if (store) showEarly(store, prompt)
        return live.send(prompt)
      }
      const hidden = store ? hiddenPrompts(store.state).at(-1) : undefined
      if (hidden === undefined) return out()
      return live.goBack(hidden).then((back) => (back.ok ? out() : { ok: false, problem: back.problem }))
    },
    cut(before) {
      intent("cut", { before })
      const { store } = options
      const from = store?.state.items.findIndex((id) => {
        const item = store.state.byId[id]
        return item?.kind === "user" && item.uuid === before
      })
      const userId = from === undefined ? undefined : store?.state.items[from]
      if (store && from !== undefined && userId !== undefined) {
        const users = store.state.items.slice(from).filter((id) => store.state.byId[id]?.kind === "user")
        store.rewind({ userId, prompts: users.length, files: [], keptFiles: true })
      }
      return running().agent.cut(before)
    },
    undoCut() {
      intent("undoCut")
      options.store?.redo()
      return running().agent.undoCut()
    },
    async until<T extends AgentEventType>(
      type: T,
      match?: (event: Extract<AgentEvent, { type: T }>) => boolean,
      timeoutMs = timeout,
    ): Promise<Extract<AgentEvent, { type: T }>> {
      intent("until", { type })
      const wanted = (event: AgentEvent): event is Extract<AgentEvent, { type: T }> => event.type === type
      const found = await running().follower.until(
        type,
        (event) => wanted(event) && (match?.(event) ?? true),
        timeoutMs,
      )
      if (!wanted(found)) throw new Error(`got ${found.type} for ${type}`)
      return found
    },
    interrupt() {
      intent("interrupt")
      return running().agent.interrupt()
    },
    setMode(mode) {
      intent("setMode", { mode })
      return running().agent.setMode(mode)
    },
    setModel(model) {
      intent("setModel", { model })
      return running().agent.setModel(model)
    },
    setEffort(effort) {
      intent("setEffort", { effort })
      return running().agent.setEffort(effort)
    },
    rename(title) {
      intent("rename", { title })
      return running().agent.rename(title)
    },
    answer(ask, reply) {
      intent("answer", { ask, reply })
      return running().agent.answer(ask, reply)
    },
    background() {
      intent("background")
      return running().agent.tasks.background()
    },
    stop(task) {
      intent("stop", { task })
      return running().agent.tasks.stop(task)
    },
    refresh(list) {
      intent("refresh", { list })
      running().agent.refresh(list)
    },
    removeRule(id) {
      intent("permissions.remove", { id })
      return running().agent.permissions.remove(id)
    },
    toggleMcp(name, on) {
      intent("mcp.toggle", { name, on })
      return running().agent.mcp.toggle(name, on)
    },
    reconnectMcp(name) {
      intent("mcp.reconnect", { name })
      return running().agent.mcp.reconnect(name)
    },
    async files(query) {
      intent("files", { query })
      const paths = await running().agent.files(query)
      outputs.push({ files: paths })
      return paths
    },
    setClientTools(tools) {
      intent("setClientTools", { tools: tools.map((tool) => `${tool.server}.${tool.name}`) })
      clientTools = tools
      return agent ? agent.setClientTools(tools) : Promise.resolve({ ok: true, note: null })
    },
    async sessions() {
      intent("sessions")
      const found = await kind.sessions(options.directory)
      outputs.push({ sessions: found })
      return found
    },
    async history(id, cursor = null) {
      intent("history", { id, cursor })
      const page = await kind.history({ agent: OPENCODE, id }, cursor)
      outputs.push({ history: page })
      return page
    },
    async context() {
      intent("context")
      const report = await running().agent.context()
      outputs.push({ context: report })
      return report
    },
    async http(method, path, body) {
      intent("http", { method, path, ...(body === undefined ? {} : { body }) })
      const service = deps.service
      if (!transport && service && make)
        transport = make(await service(deps.binary?.() ?? "opencode"), options.directory)
      if (!transport) throw new Error("the scenario has no transport yet")
      const reply = await transport.request({ method, path, body })
      if (reply.status >= 400) throw new Error(`${method} ${path} answered ${reply.status}`)
      return reply
    },
    async settings() {
      intent("settings")
      const rows = await running().agent.settings.rows()
      outputs.push({ settings: rows })
      return rows
    },
    writeSetting(id, value) {
      intent("settings.write", { id, value })
      return running().agent.settings.write(id, value)
    },
    async reconnect() {
      intent("reconnect")
      reconnects += 1
      options.cut?.()
      const done = running().agent.connected(reconnects + 1)
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no reconnect within ${timeout} ms`)), timeout)
      })
      await Promise.race([done, late]).finally(() => clearTimeout(timer))
    },
    async pause(ms) {
      intent("pause", { ms })
      if (options.live) return Bun.sleep(ms)
      // A replay lets out the events recorded during the pause first.
      await options.settled?.(intents)
      await Bun.sleep(0)
    },
    session: () => running().agent.session.id,
    async close() {
      await agent?.close()
    },
  }
}

const quickClock: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() }

// What our own MCP server says it is in recordings, so a new YellowCode version replays the same.
export const OWN_VERSION = "<version>"

export type AgentReplay = { events: AgentEvent[]; outputs: DriverOutput[]; transport: ReplayTransport }

// Runs a scenario's adapter steps on a replay of `fixture`. `prepare` may drop events before it starts.
// `files` are what the adapter reads from disk, by path; a replay reads nothing else.
export async function replayAgent(
  run: (driver: AgentDriver) => Promise<void>,
  fixture: Fixture,
  options: {
    store?: SessionStore
    prepare?: (transport: ReplayTransport) => void
    timeoutMs?: number
    files?: Record<string, string>
  } = {},
): Promise<AgentReplay> {
  const transport = replayTransport(fixture)
  options.prepare?.(transport)
  const driver = createAgentDriver({
    directory: "<root>/project",
    store: options.store,
    settled: (n) => transport.settled(n),
    timeoutMs: options.timeoutMs ?? 5_000,
    deps: {
      detect: () => Promise.resolve({ installed: true, version: fixture.meta.opencode, blocked: null, signedIn: null }),
      binary: () => "opencode",
      service: () => Promise.resolve({ url: "http://replay.invalid" }),
      transport: () => transport,
      clock: quickClock,
      appVersion: OWN_VERSION,
      readFile: (path) => Promise.resolve(options.files?.[path] ?? null),
    },
  })
  await run(driver)
  await driver.close()
  return { events: driver.events, outputs: driver.outputs, transport }
}
