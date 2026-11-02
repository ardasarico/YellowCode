// One pi session on a `pi --mode rpc` of its own, spawned in the session's folder. Commands go to stdin as JSON lines
// and are paired with their responses by id; everything else pi writes is a session event or an extension's request.
import { join } from "node:path"
import type { Agent, AgentKind, Detection, Prompt, StartOptions } from "../../agent/agent.ts"
import type { AgentEvent, SessionInfo } from "../../agent/events.ts"
import type { EffortId, ModelRef, ModeId, Outcome, PromptId } from "../../agent/ids.ts"
import type { CommandRow, ListName, ModeRow } from "../../agent/lists.ts"
import { log } from "../../log/log.ts"
import { yellowcodeHome } from "../../update/method.ts"
import { queue, stdioTransport, type Transport } from "../codex/transport.ts"
import { createAsks } from "./asks.ts"
import { PI, PI_CAPS, PI_NAME } from "./caps.ts"
import { detect } from "./detect.ts"
import { historyPage } from "./history.ts"
import { modelGroups, readModels, type PiModel } from "./models.ts"
import { promptMap, type PromptMap } from "./prompts.ts"
import { findSession, listSessions, readSession } from "./sessions.ts"
import { createTranslator, type Via } from "./translate.ts"
import {
  clearedQueue,
  commands,
  event,
  forked,
  forkMessages,
  levels,
  promptReply,
  response,
  stateOf,
  stats,
  type State,
} from "./wire.ts"

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
  prompts: PromptMap
  // Where pi's folders are found (PI_CODING_AGENT_DIR and the like).
  env: Record<string, string | undefined>
}

const realDeps: Deps = {
  detect: () => detect(),
  prompts: promptMap(join(yellowcodeHome(), "pi-prompts")),
  env: process.env,
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

// What a resume opens with: the session itself, a copy of it, or (with `at`) the session, which a fork then copies
// up to before that prompt.
function openArgs(options: StartOptions): string[] {
  const resume = options.resume
  if (!resume) return []
  if (resume.fork && resume.at === null) return ["--fork", resume.ref.id]
  return ["--session-id", resume.ref.id]
}

const entryOf = (map: Map<string, PromptId>, prompt: PromptId) =>
  [...map].find(([, known]) => known === prompt)?.[0] ?? null

async function start(options: StartOptions, deps: Deps): Promise<Agent> {
  const version = await usable(deps)
  let { pi, state } = await open(deps, options.cwd, openArgs(options))
  let session = state.sessionId
  const out = queue<AgentEvent>()
  const translator = createTranslator(options.cwd)
  let ended = false
  let closed = false
  let commandList: CommandRow[] = []
  let catalog: PiModel[] = []
  let model: ModelRef | null = state.model ? { provider: state.model.provider, id: state.model.id } : null
  let window = state.model?.contextWindow ?? null
  let used = 0
  // The prompts of user messages told since the session opened here, in order; null for one that is not ours.
  let told: (PromptId | null)[] = []
  // The entry a rewind goes back to before, taken with the next send.
  let pendingCut: string | null = null
  // The session's name; pi's copy of a session has none.
  let named = state.sessionName
  const tell = (...events: AgentEvent[]) => {
    for (const one of events) out.push(one)
  }

  const source = options.resume?.ref.id ?? null
  if (source !== null && source !== session) deps.prompts.add(session, [...deps.prompts.read(source)])

  const asks = createAsks({ respond: (id, fields) => pi.answer(id, fields), tell: (events) => tell(...events) })

  // Status lines, widgets, titles and editor text have no place in YellowCode; they are left out.
  function request(raw: Record<string, unknown>): AgentEvent[] {
    if (raw["method"] === "notify") {
      const level = raw["notifyType"] === "error" ? "error" : raw["notifyType"] === "warning" ? "warning" : "info"
      const text = typeof raw["message"] === "string" ? raw["message"] : ""
      return [{ type: "notice", level, text, at: now() }]
    }
    const opened = asks.open(raw, now())
    return opened.length > 0 ? opened : [{ type: "seen", at: now() }]
  }

  // The entry ids of the user messages told here, matched from the end of pi's list of them.
  async function learnEntries(): Promise<void> {
    if (told.length === 0) return
    const listed = forkMessages.safeParse(await pi.command("get_fork_messages"))
    if (!listed.success) return
    const ours = listed.data.messages.slice(-told.length)
    const pairs = ours.flatMap((one, index): [string, PromptId][] => {
      const prompt = told[told.length - ours.length + index]
      return prompt ? [[one.entryId, prompt]] : []
    })
    deps.prompts.add(session, pairs)
  }

  // After a turn: what the session cost so far and how full the context is.
  async function readStats(): Promise<number | null> {
    const read = stats.safeParse(await pi.command("get_session_stats"))
    if (!read.success) return null
    const usage = read.data.contextUsage
    if (usage?.tokens !== undefined && usage.tokens !== null) {
      used = usage.tokens
      tell({ type: "context.used", tokens: used, at: now() })
    }
    if (usage?.contextWindow !== undefined && usage.contextWindow !== window) {
      window = usage.contextWindow
      tell({ type: "context.window", tokens: window, at: now() })
    }
    return read.data.cost ?? null
  }

  async function settled(events: AgentEvent[]): Promise<AgentEvent[]> {
    const end = events.findIndex((one) => one.type === "turn.end")
    if (end < 0) return events
    const cost = await readStats().catch(() => null)
    await learnEntries().catch((error: unknown) => log.warn("pi: could not read the entry ids", problemOf(error)))
    return events.map((one) => (one.type === "turn.end" ? { ...one, sessionCostUsd: cost } : one))
  }

  async function pump(own: Client): Promise<void> {
    for await (const raw of own.events) {
      if (isRecord(raw) && raw["type"] === "extension_ui_request") {
        tell(...request(raw))
        continue
      }
      const parsed = event.safeParse(raw)
      if (!parsed.success) {
        tell(
          isRecord(raw) && typeof raw["type"] === "string"
            ? { type: "seen", at: now() }
            : { type: "unreadable", what: "pi", at: now() },
        )
        continue
      }
      if (parsed.data.type === "thinking_level_changed") {
        tell({ type: "effort", effort: parsed.data.level, at: now() })
        continue
      }
      const events = translator.event(parsed.data, now())
      for (const one of events) if (one.type === "user" && !one.history) told.push(one.prompt)
      tell(...(await settled(events)))
    }
    if (closed || own !== pi) return
    ended = true
    tell(...asks.gone(now()), ...translator.gone(now()), { type: "ended", problem: GONE, at: now() })
  }

  const follow = (own: Client) =>
    void pump(own).catch((error: unknown) => {
      log.error("pi: the event pump failed", error)
      if (closed || ended || own !== pi) return
      ended = true
      tell({ type: "ended", problem: GONE, at: now() })
    })

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

  // The current model's levels are pi's own answer; the others' are worked out from their level maps.
  async function readModelList(): Promise<void> {
    try {
      catalog = readModels(await pi.command("get_available_models"))
      const current = levels.safeParse(await pi.command("get_available_thinking_levels"))
      if (current.success && model)
        catalog = catalog.map((one) =>
          one.provider === model?.provider && one.id === model.id
            ? {
                ...one,
                levels: current.data.levels.length === 1 && current.data.levels[0] === "off" ? [] : current.data.levels,
              }
            : one,
        )
      tell({ type: "lists", lists: { models: modelGroups(catalog) }, at: now() })
    } catch (error) {
      log.warn("pi: could not read the models", problemOf(error))
    }
  }

  // A session opened at a prompt is copied up to before it.
  if (options.resume?.fork && options.resume.at !== null) {
    const entry = entryOf(deps.prompts.read(session), options.resume.at)
    const copied =
      entry === null ? null : forked.safeParse(await pi.command("fork", { entryId: entry }).catch(() => null))
    const reopened = copied?.success && !copied.data.cancelled ? stateOf(await pi.command("get_state")) : null
    if (!reopened) {
      await pi.close()
      throw new Error("Pi could not copy the session at that prompt")
    }
    deps.prompts.add(reopened.sessionId, [...deps.prompts.read(session)])
    state = reopened
    session = reopened.sessionId
    info.id = session
  }

  tell(
    { type: "ready", at: now() },
    { type: "info", info: { ...info }, at: now() },
    { type: "model", model, at: now() },
    ...(state.thinking === null ? [] : [{ type: "effort" as const, effort: state.thinking, at: now() }]),
    ...(window === null ? [] : [{ type: "context.window" as const, tokens: window, at: now() }]),
    ...(state.sessionName === null ? [] : [{ type: "title" as const, title: state.sessionName, at: now() }]),
    { type: "mode", mode: NO_APPROVALS.id, at: now() },
    { type: "lists", lists: { modes: [NO_APPROVALS] }, at: now() },
  )
  follow(pi)

  async function go(prompt: Prompt, via: Via): Promise<Outcome> {
    translator.sent(prompt.id, prompt.text, via)
    const type = via === "start" ? "prompt" : via === "steer" ? "steer" : "follow_up"
    const images = prompt.images.map((image) => ({ type: "image", data: image.base64, mimeType: image.mediaType }))
    try {
      const reply = promptReply.safeParse(
        await pi.command(type, { message: prompt.text, ...(images.length > 0 ? { images } : {}) }),
      )
      if (reply.success && reply.data.disposition === "handled")
        tell(...translator.handled(prompt.id, prompt.text, now()))
      return { ok: true, note: null }
    } catch (error) {
      translator.forget(prompt.id)
      throw error
    }
  }

  // A rewind's cut: pi copies the session up to before the entry, and the conversation goes on in the copy. The
  // session left behind stays in /resume.
  async function takeCut(entry: string): Promise<void> {
    const copied = forked.safeParse(await pi.command("fork", { entryId: entry }))
    if (!copied.success || copied.data.cancelled) throw new Error("Pi did not go back")
    const next = stateOf(await pi.command("get_state"))
    if (!next) throw new Error("Pi gave a state YellowCode cannot read")
    deps.prompts.add(next.sessionId, [...deps.prompts.read(session)])
    session = next.sessionId
    told = []
    pendingCut = null
    if (named !== null) await pi.command("set_session_name", { name: named }).catch(() => undefined)
    info.id = session
    tell({ type: "info", info: { ...info }, at: now() })
  }

  // While a turn runs a prompt is steered into it or queued after it; a turn that ended meanwhile leaves it to start
  // one of its own.
  async function send(prompt: Prompt): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    try {
      if (pendingCut !== null) await takeCut(pendingCut)
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

  async function cut(before: PromptId): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    let entry = entryOf(deps.prompts.read(session), before)
    if (entry === null) {
      await learnEntries().catch(() => undefined)
      entry = entryOf(deps.prompts.read(session), before)
    }
    if (entry === null) return { ok: false, problem: "Pi has no record of that prompt to go back to" }
    pendingCut = entry
    return { ok: true, note: null }
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
      told = []
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

  async function act(what: string, run: () => Promise<unknown>): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    try {
      await run()
      return { ok: true, note: null }
    } catch (error) {
      log.warn(`pi: ${what} failed`, problemOf(error))
      return { ok: false, problem: problemOf(error) }
    }
  }

  const setModel = (choice: ModelRef) =>
    act("the model switch", async () => {
      await pi.command("set_model", { provider: choice.provider, modelId: choice.id })
      model = choice
      info.model = choice
      tell({ type: "model", model: choice, at: now() })
      const picked = catalog.find((one) => one.provider === choice.provider && one.id === choice.id)
      if (picked?.contextWindow) {
        window = picked.contextWindow
        tell({ type: "context.window", tokens: window, at: now() })
      }
      const read = levels.safeParse(await pi.command("get_available_thinking_levels"))
      if (read.success && picked) {
        catalog = catalog.map((one) => (one === picked ? { ...one, levels: read.data.levels } : one))
        tell({ type: "lists", lists: { models: modelGroups(catalog) }, at: now() })
      }
    })

  const setEffort = (level: EffortId | null) =>
    act("the thinking level", async () => {
      if (level === null) return
      await pi.command("set_thinking_level", { level })
      tell({ type: "effort", effort: level, at: now() })
    })

  const rename = (title: string) =>
    act("rename", async () => {
      await pi.command("set_session_name", { name: title })
      named = title
    })

  function refresh(list: ListName): void {
    if (list === "commands") void readCommands()
    else if (list === "models") void readModelList()
    else if (list === "modes") tell({ type: "lists", lists: { modes: [NO_APPROVALS] }, at: now() })
  }

  const setMode = (mode: ModeId): Promise<Outcome> =>
    Promise.resolve(
      mode === NO_APPROVALS.id ? { ok: true, note: null } : { ok: false, problem: "Pi has no other modes" },
    )

  return {
    kind: PI,
    get session() {
      return { agent: PI, id: session }
    },
    version,
    caps: PI_CAPS,
    events: out.items,
    send,
    interrupt,
    answer(id, reply) {
      tell(...asks.answer(id, reply, now()))
      return Promise.resolve()
    },
    restart,
    async close() {
      if (closed) return
      closed = true
      await pi.close()
      tell(...asks.gone(now()), { type: "ended", problem: null, at: now() })
      out.end()
    },
    setMode,
    setModel,
    setEffort,
    setExtraEffort: later("extra effort"),
    setThinking: later("thinking on and off"),
    rename,
    cut,
    undoCut() {
      pendingCut = null
      return Promise.resolve({ ok: true, note: null })
    },
    refresh,
    tasks: { stop: later("tasks"), background: later("background now") },
    mcp: { toggle: later("MCP"), reconnect: later("MCP"), login: later("MCP") },
    skills: { toggle: later("skills"), reload: later("skills") },
    plugins: { toggle: later("plugins"), reload: later("plugins") },
    permissions: { remove: later("permissions") },
    settings: { rows: () => Promise.reject(new Error("Pi settings are not built yet")), write: later("settings") },
    context: () =>
      Promise.resolve({
        model: model?.id ?? "",
        used,
        window: window ?? 0,
        categories: [],
        files: [],
        tools: [],
      }),
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
    sessions: (cwd) => Promise.resolve(listSessions(cwd, merged.env)),
    async listModels(cwd) {
      await usable(merged)
      const pi = client(merged.spawn(cwd, ["--no-session"]))
      try {
        return modelGroups(readModels(await pi.command("get_available_models")))
      } finally {
        await pi.close()
      }
    },
    history(ref) {
      const path = findSession(ref.id, merged.env)
      const file = path === null ? null : readSession(path)
      if (!file) return Promise.reject(new Error("Pi has no such session"))
      return Promise.resolve(historyPage(file.entries, merged.prompts.read(ref.id), file.cwd))
    },
  }
}
