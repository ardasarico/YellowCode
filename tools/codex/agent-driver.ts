// Scenario steps that drive the Codex adapter itself: the recorder runs them on live app-servers, tests and --check
// run them on a replay of the fixture, one replayed app-server per recorded one.
import type { ContextReport, Prompt, StartOptions } from "../../src/agent/agent.ts"
import type { AskReply } from "../../src/agent/ask.ts"
import type { AgentEvent, AgentEventType } from "../../src/agent/events.ts"
import type { AskId, EffortId, ModeId, ModelRef, Outcome, PromptId, TaskId } from "../../src/agent/ids.ts"
import type { ListName } from "../../src/agent/lists.ts"
import type { SettingRow, SettingValue } from "../../src/agent/settings.ts"
import type { HistoryCursor, HistoryPage, SessionEntry } from "../../src/agent/sessions.ts"
import { CODEX_COMMANDS, codexKind, startCodex, type CodexAgent, type Deps } from "../../src/agents/codex/agent.ts"
import { CODEX } from "../../src/agents/codex/caps.ts"
import type { Fixture } from "../../src/agents/codex/fixture.ts"
import { replayTransport, type ReplayTransport } from "../../src/agents/codex/replay-transport.ts"
import type { Transport } from "../../src/agents/codex/transport.ts"
import { commandOf } from "../../src/input/commands.ts"
import { showEarly } from "../../src/session/follow.ts"
import type { SessionStore } from "../../src/session/session.ts"
import { follow, type Follower } from "../opencode/driver.ts"
import { CLIENT_INFO, createDriver, pick, type Driver } from "./driver.ts"

export type AgentDriver = {
  directory: string
  // Starts the agent, on a thread of its own or an earlier one; a running agent is closed first. Rejects as `start`
  // does.
  start(resume?: StartOptions["resume"], options?: Partial<StartOptions>): Promise<void>
  // The kind's own reads, outside a running agent. What they give is kept in `outputs`.
  sessions(): Promise<SessionEntry[]>
  history(id: string, cursor?: HistoryCursor | null): Promise<HistoryPage>
  oneShot(prompt: string): Promise<string | null>
  // Prompts are numbered from prompt-1. `delivery` matters while a turn runs. A text that starts with one of the
  // adapter's commands runs it, as the app's input does.
  send(text: string, images?: Prompt["images"], delivery?: Prompt["delivery"]): Promise<Outcome>
  // The next neutral event of `type` (that `match` accepts) after the last one an `until` returned.
  until<T extends AgentEventType>(
    type: T,
    match?: (event: Extract<AgentEvent, { type: T }>) => boolean,
    timeoutMs?: number,
  ): Promise<Extract<AgentEvent, { type: T }>>
  answer(ask: AskId, reply: AskReply): Promise<void>
  refresh(list: ListName): void
  setMode(mode: ModeId): Promise<Outcome>
  setModel(model: ModelRef): Promise<Outcome>
  setEffort(effort: EffortId | null): Promise<Outcome>
  setThinking(shown: boolean): Promise<Outcome>
  interrupt(): Promise<Outcome>
  cut(before: PromptId): Promise<Outcome>
  undoCut(): Promise<Outcome>
  // The chat's go-back before a send, at the oldest prompt it hides.
  goBack(before: PromptId | null): Promise<Outcome>
  stopTask(id: TaskId): Promise<Outcome>
  rename(title: string): Promise<Outcome>
  // Kept in `outputs`.
  context(): Promise<ContextReport>
  settings(): Promise<SettingRow[]>
  writeSetting(id: string, value: SettingValue): Promise<Outcome>
  files(query: string): Promise<string[]>
  toggleSkill(id: string, on: boolean): Promise<Outcome>
  reloadSkills(): Promise<Outcome>
  reconnectMcp(name: string): Promise<Outcome>
  loginMcp(name: string): Promise<Outcome>
  // A request on the running agent's app-server that the agent does not see, as another client's would be.
  raw(method: string, params: unknown): Promise<unknown>
  // Raw steps on an app-server of their own, closed after, such as making a thread the adapter would not.
  prepare<T>(steps: (d: Driver) => Promise<T>): Promise<T>
  // Live, the running agent's app-server is killed; a replay plays the exit it recorded.
  kill(): void
  restart(): Promise<Outcome>
  session(): string
  close(): Promise<void>
}

export type DriverOutput =
  | { sessions: SessionEntry[] }
  | { history: HistoryPage }
  | { context: ContextReport }
  | { answer: string | null }
  | { settings: SettingRow[] }
  | { files: string[] }

// A spawned app-server; a live one can be killed.
export type Spawned = Transport & { kill?(): void }

export type AgentDriverOptions = {
  directory: string
  spawn(cwd: string): Spawned
  detect: Deps["detect"]
  // Fed every event, with each prompt shown at Enter first, as the app does.
  store?: SessionStore
  onIntent?: (intent: string, args: unknown) => void
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
  let agent: CodexAgent | null = null
  let follower: Follower<AgentEvent> | null = null
  let server: Spawned | null = null
  let prompts = 0
  let raws = 0
  // Replies to raw requests, which the agent's own client never sees.
  const rawReplies = new Map<string, (message: unknown) => void>()
  const intent = (name: string, args: unknown = {}) => options.onIntent?.(name, args)
  const deps: Partial<Deps> = {
    detect: () => options.detect(),
    spawn: (cwd) => options.spawn(cwd),
    appVersion: CLIENT_INFO.version,
    // A login page is never opened from a recording.
    openUrl: () => Promise.resolve(false),
  }
  const agentDeps: Partial<Deps> = {
    ...deps,
    spawn(cwd) {
      server = withRaw(options.spawn(cwd), rawReplies)
      return server
    },
  }
  const kind = codexKind(deps)
  // The commands as the agent last listed them, which a typed command is read against, as the app's input does.
  const commands = () =>
    events.findLast(
      (event): event is Extract<AgentEvent, { type: "lists" }> =>
        event.type === "lists" && event.lists.commands !== undefined,
    )?.lists.commands ?? CODEX_COMMANDS
  const running = () => {
    if (!agent || !follower) throw new Error("the scenario has not started the agent")
    return { agent, follower }
  }

  return {
    directory: options.directory,
    events,
    outputs,
    async start(resume = null, extra = {}) {
      // A client tool is told by its name; its code stays out of the fixture.
      const tools = extra.clientTools?.map((tool) => `${tool.server}.${tool.name}`)
      intent("start", { ...(resume ? { resume } : {}), ...extra, ...(tools ? { clientTools: tools } : {}) })
      await agent?.close()
      agent = null
      const started = await startCodex({ ...START, ...extra, cwd: options.directory, resume }, agentDeps)
      agent = started
      follower = follow<AgentEvent, AgentEvent>(
        started.events,
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
        command: commandOf(text, commands()),
        to: null,
        delivery,
        kept: [],
        shells: [],
      }
      if (options.store) showEarly(options.store, prompt)
      return running().agent.send(prompt)
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
    answer(ask, reply) {
      intent("answer", { ask, reply })
      return running().agent.answer(ask, reply)
    },
    refresh(list) {
      intent("refresh", { list })
      running().agent.refresh(list)
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
    setThinking(shown) {
      intent("setThinking", { shown })
      return running().agent.setThinking(shown)
    },
    interrupt() {
      intent("interrupt")
      return running().agent.interrupt()
    },
    cut(before) {
      intent("cut", { before })
      return running().agent.cut(before)
    },
    undoCut() {
      intent("undoCut")
      return running().agent.undoCut()
    },
    goBack(before) {
      intent("goBack", { before })
      return running().agent.goBack(before)
    },
    stopTask(id) {
      intent("stopTask", { id })
      return running().agent.tasks.stop(id)
    },
    rename(title) {
      intent("rename", { title })
      return running().agent.rename(title)
    },
    async context() {
      intent("context")
      const report = await running().agent.context()
      outputs.push({ context: report })
      return report
    },
    async settings() {
      intent("settings")
      const rows = await running().agent.settings.rows()
      outputs.push({ settings: rows })
      return rows
    },
    writeSetting(id, value) {
      intent("writeSetting", { id, value })
      return running().agent.settings.write(id, value)
    },
    async files(query) {
      intent("files", { query })
      const found = await running().agent.files(query)
      outputs.push({ files: found })
      return found
    },
    toggleSkill(id, on) {
      intent("toggleSkill", { id, on })
      return running().agent.skills.toggle(id, on)
    },
    reloadSkills() {
      intent("reloadSkills")
      return running().agent.skills.reload()
    },
    reconnectMcp(name) {
      intent("reconnectMcp", { name })
      return running().agent.mcp.reconnect(name)
    },
    loginMcp(name) {
      intent("loginMcp", { name })
      return running().agent.mcp.login(name)
    },
    raw(method, params) {
      intent("raw", { method, params })
      const target = server
      if (!target) throw new Error("the scenario has not started the agent")
      const id = `raw-${++raws}`
      return new Promise((resolve, reject) => {
        rawReplies.set(id, (message) => {
          const error = pick(message, "error")
          if (error === undefined) resolve(pick(message, "result"))
          else reject(new Error(`${method}: ${JSON.stringify(error)}`))
        })
        target.send({ id, method, params })
      })
    },
    async prepare(steps) {
      intent("prepare")
      const d = createDriver(options.spawn(options.directory), { directory: options.directory })
      try {
        return await steps(d)
      } finally {
        await d.close()
      }
    },
    kill() {
      intent("kill")
      server?.kill?.()
    },
    restart() {
      intent("restart")
      return running().agent.restart({ mode: null, defaultMode: null, thinking: false })
    },
    async sessions() {
      intent("sessions")
      const found = await kind.sessions(options.directory)
      outputs.push({ sessions: found })
      return found
    },
    async history(id, cursor = null) {
      intent("history", { id, cursor })
      const page = await kind.history({ agent: CODEX, id }, cursor)
      outputs.push({ history: page })
      return page
    },
    async oneShot(prompt) {
      intent("oneShot", { prompt })
      const answer = (await kind.oneShot?.(prompt, options.directory)) ?? null
      outputs.push({ answer })
      return answer
    },
    session: () => running().agent.session.id,
    async close() {
      await agent?.close()
    },
  }
}

// The spawned app-server with the replies to raw requests taken out of its messages.
function withRaw(inner: Spawned, replies: Map<string, (message: unknown) => void>): Spawned {
  async function* messages(): AsyncIterable<unknown> {
    for await (const message of inner.messages) {
      const id = pick(message, "id")
      const reply = typeof id === "string" && pick(message, "method") === undefined ? replies.get(id) : undefined
      if (reply && typeof id === "string") {
        replies.delete(id)
        reply(message)
      } else yield message
    }
  }
  return { ...inner, messages: messages(), send: (message) => inner.send(message), close: () => inner.close() }
}

export type AgentReplay = { events: AgentEvent[]; outputs: DriverOutput[]; transports: ReplayTransport[] }

// Runs a scenario's adapter steps on a replay of `fixture`.
export async function replayAgent(
  run: (driver: AgentDriver) => Promise<void>,
  fixture: Fixture,
  options: { store?: SessionStore; timeoutMs?: number } = {},
): Promise<AgentReplay> {
  const transports: ReplayTransport[] = []
  const driver = createAgentDriver({
    directory: "<root>/project",
    store: options.store,
    timeoutMs: options.timeoutMs ?? 5_000,
    detect: () => Promise.resolve({ installed: true, version: fixture.meta.codex, blocked: null, signedIn: null }),
    spawn() {
      const transport = replayTransport(fixture, transports.length)
      transports.push(transport)
      return transport
    },
  })
  await run(driver)
  await driver.close()
  return { events: driver.events, outputs: driver.outputs, transports }
}
