// One Codex thread on a `codex app-server` of its own, spawned in the session's folder. The kind's lists read a
// short-lived app-server each.
import { appVersion } from "../../build-info.ts"
import type { Agent, AgentKind, Detection, Prompt, StartOptions } from "../../agent/agent.ts"
import type { AgentEvent, SessionInfo } from "../../agent/events.ts"
import type { EffortId, ModeId, ModelRef, Outcome, PromptId, TaskId } from "../../agent/ids.ts"
import type { ListName, McpServerRow, ModeRow, SkillRow } from "../../agent/lists.ts"
import { log } from "../../log/log.ts"
import { defaultProvider } from "./allow.ts"
import { createAsks } from "./asks.ts"
import { CODEX, CODEX_CAPS, CODEX_NAME } from "./caps.ts"
import { dynamicTools, serverConfig } from "./client-tools.ts"
import { createCuts } from "./cut.ts"
import { detect, findBinary } from "./detect.ts"
import { historyPage, turnOf } from "./history.ts"
import { commandRows, findFiles, readHooks, readMcp, readPlugins, readSkills, STARTUP } from "./lists.ts"
import {
  accessFields,
  accessOf,
  accessOfSettings,
  collaboration,
  fixedMode,
  modeRows,
  PLAN,
  startFields,
  type Access,
} from "./modes.ts"
import { readModels } from "./models.ts"
import { cachedWindows, withWindows } from "./models-cache.ts"
import { listSessions } from "./sessions.ts"
import { createSettings } from "./settings.ts"
import { createDelivery } from "./steer.ts"
import { contextReport, limitsOf } from "./usage.ts"
import { answerOnce } from "./titles.ts"
import { createTranslator } from "./translate.ts"
import { queue, rpcClient, RpcError, stdioTransport, type Rpc, type Transport } from "./transport.ts"
import { mcpStartup, oauthDone, oauthLogin, skillsWriteResult } from "./wire/lists.ts"
import { createNotificationReader, type Notification } from "./wire/notifications.ts"
import { collaborationModes, permissionProfiles, type CodexModel, type ThreadSettings } from "./wire/settings.ts"
import {
  accountResult,
  initializeResult,
  rateLimitsResult,
  resultOf,
  terminalsPage,
  terminateResult,
  threadStartResult,
} from "./wire/thread.ts"

const START_MS = 15_000
const GONE = { text: "Codex stopped responding", detail: [] }
const SIGN_IN = "Sign in with `codex login`"
const HELD = "Codex has this session open in another program"
const DOWN = "Codex is not connected"
const NEXT_TURN = "Codex takes it from the next turn"
const IDLE = "Codex is not running a turn"
// app-server's words when another app-server writes the thread.
const WRITER = /already has an active writer/
const TITLE_MS = 30_000

export { CODEX_COMMANDS } from "./lists.ts"

// `goBack` takes the pending cut now, at `before`, the oldest prompt the chat hides (null: the pending one), so the
// chat shows the next prompt only once the conversation went back.
export type CodexAgent = Agent & { goBack(before: PromptId | null): Promise<Outcome> }

export type Deps = {
  detect(): Promise<Detection>
  // A new app-server in `cwd`.
  spawn(cwd: string): Transport
  // What YellowCode tells app-server it is.
  appVersion: string
  // Opens an MCP server's login page in the browser; false when it could not.
  openUrl(url: string): Promise<boolean>
}

function spawnServer(cwd: string): Transport {
  const binary = findBinary()
  if (!binary) throw new Error("Codex is not installed")
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  // stderr is Codex's own log; it is left unread.
  return stdioTransport({ command: [binary, "app-server"], cwd, env })
}

const OPENER = process.platform === "darwin" ? "open" : "xdg-open"

async function openUrl(url: string): Promise<boolean> {
  try {
    return (await Bun.spawn([OPENER, url], { stdout: "ignore", stderr: "ignore" }).exited) === 0
  } catch {
    return false
  }
}

// The address comes from the MCP server, so only a web page goes to the system opener.
function webPage(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}

const realDeps: Deps = { detect: () => detect(), spawn: spawnServer, appVersion: appVersion, openUrl }

const notYet = (what: string): Outcome => ({ ok: false, problem: `Codex ${what} is not built yet` })
const later = (what: string) => () => Promise.resolve(notYet(what))
const problemOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function within<T>(promise: Promise<T>, what: string, ms = START_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer`)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

// "yellowcode/0.165.0 (Mac OS 15.0; arm64) ..." gives "0.165.0".
const versionOf = (userAgent: string) => /\/(\d+\.\d+\.\d+\S*)/.exec(userAgent)?.[1] ?? null

async function usable(deps: Deps): Promise<string> {
  const found = await deps.detect()
  if (!found.installed) throw new Error("Codex is not installed")
  if (found.blocked) throw new Error(found.blocked)
  return found.version
}

// A spawned app-server after the handshake. With `signIn`, one nobody is signed in to is closed again: YellowCode
// never signs in itself. `limited`: the sign-in has usage limits to read.
async function connect(
  deps: Deps,
  cwd: string,
  signIn: boolean,
): Promise<{ rpc: Rpc; version: string | null; limited: boolean }> {
  const rpc = rpcClient(deps.spawn(cwd))
  try {
    const init = resultOf(
      await within(
        rpc.request("initialize", {
          clientInfo: { name: "yellowcode", title: "YellowCode", version: deps.appVersion },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }),
        "Codex",
      ),
      initializeResult,
      "initialize",
    )
    if (init.kind !== "ok") throw new Error("Codex did not say what it is")
    rpc.notify("initialized")
    let limited = false
    if (signIn) {
      const account = resultOf(await within(rpc.request("account/read", {}), "Codex"), accountResult, "account/read")
      if (account.kind === "ok" && !account.value.signedIn) throw new Error(SIGN_IN)
      limited = account.kind === "ok" && account.value.limited
    }
    return { rpc, version: versionOf(init.value.userAgent), limited }
  } catch (error) {
    await rpc.close()
    throw error
  }
}

// The user's plugins, hooks and apps stay off. Codex has no switch for the MCP servers of the user's config.
const PLAIN = { "features.plugins": false, "features.hooks": false, "features.apps": false }

function withConfig(servers: { config?: Record<string, unknown> }, more: Record<string, unknown>) {
  const config = { ...servers.config, ...more }
  return Object.keys(config).length === 0 ? {} : { config }
}

// The thread `start` makes, resumes or copies, with Codex's reply. A new one starts in `mode` and on the model asked
// for, when they are given.
async function openThread(rpc: Rpc, options: StartOptions, mode: ModeId | null = null) {
  const { resume, model } = options
  if (options.ephemeral && resume !== null) throw new Error("A session Codex does not keep cannot resume")
  const servers = serverConfig(options.mcpServers)
  const sent =
    resume === null
      ? rpc.request("thread/start", {
          cwd: options.cwd,
          historyMode: "paginated",
          dynamicTools: dynamicTools(options.clientTools),
          ...(options.ephemeral ? { ephemeral: true } : {}),
          ...withConfig(servers, options.plain ? PLAIN : {}),
          ...(mode === null ? {} : startFields(mode)),
          ...(model === null ? {} : { model: model.id }),
          ...(model?.provider ? { modelProvider: model.provider } : {}),
        })
      : resume.fork
        ? rpc.request("thread/fork", {
            threadId: resume.ref.id,
            excludeTurns: true,
            ...servers,
            ...(resume.at === null ? {} : { beforeTurnId: await turnOf(rpc, resume.ref.id, resume.at) }),
          })
        : rpc.request("thread/resume", { threadId: resume.ref.id, excludeTurns: true, ...servers })
  const reply = await sent.catch((error: unknown) => {
    throw error instanceof RpcError && WRITER.test(error.message) ? new Error(HELD) : error
  })
  const opened = resultOf(reply, threadStartResult, "thread")
  if (opened.kind !== "ok") throw new Error("Codex did not give the session")
  return opened.value
}

// Images go as `data:` urls, which the echo of the prompt gives back.
function inputOf(prompt: Prompt): unknown[] {
  const images = prompt.images.map((image) => ({
    type: "image",
    url: `data:${image.mediaType};base64,${image.base64}`,
  }))
  const text = prompt.text !== "" || images.length === 0 ? [{ type: "text", text: prompt.text, text_elements: [] }] : []
  const context = prompt.context === null ? [] : [{ type: "text", text: prompt.context, text_elements: [] }]
  return [...context, ...text, ...images]
}

async function start(options: StartOptions, deps: Deps): Promise<CodexAgent> {
  const detected = await usable(deps)
  const connected = await connect(deps, options.cwd, true)
  let { rpc, version } = connected
  const chosen = options.mode ?? (options.resume ? null : options.defaultMode)
  const opened = await openThread(rpc, options, chosen === PLAN ? null : chosen).catch(async (error: unknown) => {
    await rpc.close()
    throw error
  })
  // A cut in a legacy thread moves the session to a copy.
  let session = opened.thread.id
  let legacy = opened.thread.historyMode === "legacy"
  const out = queue<AgentEvent>()
  // What the thread runs with, as Codex last said. `effort` null is the model's own default.
  const now: { access: Access; collaboration: string; provider: string; model: string; effort: string | null } = {
    access: {
      approval: opened.approvalPolicy,
      sandbox: opened.sandbox,
      profile: opened.activePermissionProfile?.id ?? null,
    },
    collaboration: opened.collaborationMode?.mode ?? "default",
    provider: opened.modelProvider,
    model: opened.model,
    effort: opened.reasoningEffort ?? null,
  }
  const access = () => accessOf(now.access.approval, now.access.sandbox, now.access.profile)
  const mode = () => (now.collaboration === PLAN ? PLAN : access())
  // A finished plan goes on in the access it was made in.
  const translator = createTranslator(session, { cwd: opened.cwd, provider: opened.modelProvider, afterPlan: access })
  const read = createNotificationReader()
  let lastAt = opened.thread.updatedAt * 1000
  let ended = false
  let closed = false
  let thinking = options.thinking
  // The thread's name as YellowCode last set it.
  let named = opened.thread.name ?? null
  // The lists as last read, once something asked for them.
  let catalog: CodexModel[] | null = null
  let modes: ModeRow[] | null = null
  let skills: SkillRow[] | null = null
  let servers: McpServerRow[] | null = null
  // Each read of a list is numbered; an answer that a newer read overtook is not told.
  const reads = { skills: 0, mcp: 0 }
  // Servers' startup states told while the servers were being read, which the read may not have seen yet.
  const startups = new Map<string, McpServerRow["state"]>()
  const config = createSettings(() => rpc, opened.cwd)
  // A prompt sent right after a settings change waits for it, so it runs with the new settings.
  let settling: Promise<unknown> = Promise.resolve()
  // Until Codex refuses one, a change made during a turn goes to that turn too.
  let turnUpdates = true
  const tell = (...events: AgentEvent[]) => {
    for (const event of events) out.push(event)
  }
  const asks = createAsks({
    get thread() {
      return session
    },
    cwd: opened.cwd,
    lookup: translator,
    tools: () => options.clientTools,
    tell: (events) => tell(...events),
    at: () => lastAt,
  })

  const effort = () => now.effort ?? catalog?.find((model) => model.id === now.model)?.defaultReasoningEffort ?? null
  // What was told last; `effort` is not told until it is known.
  const told = { mode: mode(), model: now.model, provider: now.provider, effort: effort() }

  // What changed since it was last told.
  function changes(): AgentEvent[] {
    const events: AgentEvent[] = []
    if (mode() !== told.mode) events.push({ type: "mode", mode: mode(), at: lastAt })
    if (now.model !== told.model || now.provider !== told.provider)
      events.push({ type: "model", model: { provider: now.provider, id: now.model }, at: lastAt })
    if (effort() !== told.effort && effort() !== null) events.push({ type: "effort", effort: effort(), at: lastAt })
    Object.assign(told, { mode: mode(), model: now.model, provider: now.provider, effort: effort() })
    return events
  }

  function settled(settings: ThreadSettings): AgentEvent[] {
    Object.assign(now, {
      access: accessOfSettings(settings),
      collaboration: settings.collaborationMode?.mode ?? now.collaboration,
      provider: settings.modelProvider,
      model: settings.model,
      effort: settings.effort ?? null,
    })
    return changes()
  }

  // The main thread's notifications that need a request of ours: a turn's end (which of its commands run on, what
  // happens to the prompts that waited), the queue, and a cut. Each awaits its reply here, so what follows comes after.
  async function turnEvents(notification: Notification): Promise<AgentEvent[]> {
    const params: object = notification.params
    const main = "threadId" in params && params.threadId === session
    if (main && notification.method === "turn/completed") {
      const ours = interrupting === notification.params.turn.id
      if (ours) interrupting = null
      const shells = await background()
      const events = delivery.told(translator.notification(notification, lastAt))
      return [...shells, ...events, ...(await delivery.turnEnded(ours, lastAt))]
    }
    if (main && notification.method === "thread/queue/changed") await delivery.queueChanged()
    if (main && notification.method === "thread/reverted") {
      const before = await cuts.reverted()
      if (before !== null) return [{ type: "cut", before, at: lastAt }]
    }
    return delivery.told(translator.notification(notification, lastAt))
  }

  // Commands still running as the turn ends go on in the background when Codex lists them.
  async function background(): Promise<AgentEvent[]> {
    if (translator.lingering().length === 0) return []
    const listed = resultOf(
      await within(rpc.request("thread/backgroundTerminals/list", { threadId: session }), "Codex").catch(() => null),
      terminalsPage,
      "thread/backgroundTerminals/list",
    )
    return translator.backgrounded(listed.kind === "ok" ? listed.value.data : [], lastAt)
  }

  async function pump(own: Rpc): Promise<void> {
    for await (const message of own.incoming) {
      if (message.type === "request") {
        asks.request(own, message.id, message.method, message.params)
        tell({ type: "seen", at: lastAt })
        continue
      }
      if (message.type === "unreadable") {
        tell({ type: "unreadable", what: "codex", at: lastAt })
        continue
      }
      lastAt = message.at ?? lastAt
      if (listChanged(message.method, message.params)) {
        tell({ type: "seen", at: lastAt })
        continue
      }
      const found = read(message.method, message.params, message.at)
      if (
        found.kind === "notification" &&
        found.notification.method === "thread/settings/updated" &&
        found.notification.params.threadId === session
      ) {
        const events = settled(found.notification.params.threadSettings)
        tell(...(events.length > 0 ? events : [{ type: "seen" as const, at: lastAt }]))
        continue
      }
      if (found.kind === "notification" && found.notification.method === "serverRequest/resolved")
        asks.resolved(own, found.notification.params.requestId)
      if (found.kind === "notification") tell(...(await turnEvents(found.notification)))
      else if (found.kind === "unreadable") tell({ type: "unreadable", what: found.what, at: lastAt })
      else tell({ type: "seen", at: lastAt })
    }
    if (closed || own !== rpc) return
    ended = true
    asks.gone()
    tell(...translator.gone(lastAt), { type: "ended", problem: GONE, at: lastAt })
  }

  const follow = (own: Rpc) =>
    void pump(own).catch((error: unknown) => {
      log.error("codex: the message pump failed", error)
      if (closed || ended || own !== rpc) return
      ended = true
      asks.gone()
      tell({ type: "ended", problem: GONE, at: lastAt })
    })

  const info: SessionInfo = {
    id: session,
    model: { provider: opened.modelProvider, id: opened.model },
    mode: mode(),
    cwd: opened.cwd,
    version: version ?? detected,
    tools: [],
    mcpServers: [],
    skills: [],
    commands: [],
    subagents: [],
    plugins: [],
    authSource: "none",
  }
  // Codex's turn our interrupt stops.
  let interrupting: string | null = null
  const delivery = createDelivery({ rpc: () => rpc, thread: () => session, running: () => translator.running() })
  const cuts = createCuts({
    rpc: () => rpc,
    thread: () => session,
    legacy: () => legacy,
    lookup: translator,
    forked(copy) {
      session = copy.thread.id
      legacy = copy.thread.historyMode === "legacy"
      translator.moved(session)
      info.id = session
      tell({ type: "info", info: { ...info }, at: lastAt })
    },
  })

  tell(
    { type: "ready", at: lastAt },
    { type: "info", info: { ...info }, at: lastAt },
    { type: "model", model: { provider: opened.modelProvider, id: opened.model }, at: lastAt },
    ...(told.effort === null ? [] : [{ type: "effort" as const, effort: told.effort, at: lastAt }]),
  )
  follow(rpc)
  if (connected.limited) void readLimits()

  // Every limit the account has; Codex's later updates come one limit at a time.
  async function readLimits(): Promise<void> {
    const reply = resultOf(
      await within(rpc.request("account/rateLimits/read", {}), "Codex").catch(() => null),
      rateLimitsResult,
      "account/rateLimits/read",
    )
    if (reply.kind !== "ok" || ended || closed) return
    const { rateLimits, rateLimitsByLimitId } = reply.value
    const all = rateLimitsByLimitId ? Object.values(rateLimitsByLimitId) : [rateLimits]
    for (const limits of all) {
      const event = limits && limitsOf(limits)
      if (event) tell({ ...event, at: lastAt })
    }
  }

  // A settings change for the turns to come; `live` ones also go to the turn that runs, where Codex takes them (its
  // feature step_model_switching), else from the next turn.
  async function update(fields: Record<string, unknown>, live = false): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    const turn = live && turnUpdates ? translator.running() : null
    const sent = rpc.request("thread/settings/update", { threadId: session, ...fields })
    const inTurn =
      turn === null ? null : rpc.request("turn/settings/update", { threadId: session, turnId: turn, ...fields })
    settling = Promise.allSettled([sent, inTurn])
    try {
      await sent
    } catch (error) {
      return { ok: false, problem: problemOf(error) }
    }
    const took = await inTurn?.then(
      () => true,
      () => false,
    )
    if (took === false) turnUpdates = false
    return { ok: true, note: live && translator.running() !== null && took !== true ? NEXT_TURN : null }
  }

  async function readModes(): Promise<ModeRow[]> {
    const listed = resultOf(
      await rpc.request("collaborationMode/list", {}).catch(() => null),
      collaborationModes,
      "collaborationMode/list",
    )
    const plan = listed.kind === "ok" && listed.value.data.some((row) => row.mode === PLAN)
    const profiles = resultOf(
      await rpc.request("permissionProfile/list", { cwd: opened.cwd }).catch(() => null),
      permissionProfiles,
      "permissionProfile/list",
    )
    modes = modeRows(plan, profiles.kind === "ok" ? profiles.value.data : [])
    return modes
  }

  async function tellModes(): Promise<void> {
    const rows = await readModes()
    if (ended || closed) return
    tell({ type: "lists", lists: { modes: rows }, at: lastAt }, { type: "mode", mode: mode(), at: lastAt })
  }

  async function tellModels(): Promise<void> {
    const listed = await readModels(rpc, opened.cwd, now.provider).catch(() => null)
    if (!listed || ended || closed) return
    catalog = listed.catalog
    tell({ type: "lists", lists: { models: listed.groups }, at: lastAt }, ...changes())
  }

  // Skills come with the commands they add.
  async function tellSkills(forceReload = false): Promise<boolean> {
    const asked = ++reads.skills
    const rows = await readSkills(rpc, opened.cwd, forceReload)
    if (!rows || asked !== reads.skills || ended || closed) return rows !== null
    skills = rows
    tell({ type: "lists", lists: { skills: rows, commands: commandRows(rows) }, at: lastAt })
    return true
  }

  async function tellServers(): Promise<void> {
    const asked = ++reads.mcp
    startups.clear()
    const rows = await readMcp(rpc, session)
    if (!rows || asked !== reads.mcp || ended || closed) return
    for (const row of rows) row.state = startups.get(row.name) ?? row.state
    if (JSON.stringify(rows) === JSON.stringify(servers)) return
    servers = rows
    tell({ type: "lists", lists: { mcp: servers }, at: lastAt })
  }

  // The notifications that change a list, which the translator does not read; false for any other.
  function listChanged(method: string, params: unknown): boolean {
    if (method === "skills/changed") void tellSkills()
    else if (method === "mcpServer/startupStatus/updated") {
      const started = mcpStartup.safeParse(params)
      const state = started.success ? STARTUP[started.data.status] : undefined
      if (!started.success || state === undefined || (started.data.threadId ?? session) !== session) return true
      startups.set(started.data.name, state)
      const known = servers?.find((row) => row.name === started.data.name)
      if (!servers || !known || known.state === state) return true
      servers = servers.map((row) => (row === known ? { ...row, state, status: started.data.status } : row))
      tell({ type: "lists", lists: { mcp: servers }, at: lastAt })
    } else if (method === "mcpServer/oauthLogin/completed") {
      const done = oauthDone.safeParse(params)
      if (done.success && !done.data.success)
        tell({ type: "notice", level: "warning", text: `Codex could not log in to ${done.data.name}`, at: lastAt })
      void tellServers()
    } else return false
    return true
  }

  async function tellList<T>(load: () => Promise<T | null>, listed: (rows: T) => AgentEvent): Promise<void> {
    const rows = await load()
    if (rows && !ended && !closed) tell(listed(rows))
  }

  function refresh(list: ListName): void {
    if (ended || closed) return
    if (list === "modes") void tellModes()
    if (list === "models") void tellModels()
    if (list === "commands" || list === "skills") void tellSkills()
    if (list === "mcp") void tellServers()
    if (list === "plugins")
      void tellList(
        () => readPlugins(rpc, opened.cwd),
        (rows) => ({ type: "lists", lists: { plugins: rows }, at: lastAt }),
      )
    if (list === "hooks")
      void tellList(
        () => readHooks(rpc, opened.cwd),
        (rows) => ({ type: "lists", lists: { hooks: rows }, at: lastAt }),
      )
  }

  async function toggleSkill(id: string, on: boolean): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    const reply = resultOf(
      await rpc.request("skills/config/write", { path: id, enabled: on }).catch(() => null),
      skillsWriteResult,
      "skills/config/write",
    )
    if (reply.kind !== "ok") return { ok: false, problem: `Codex did not turn the skill ${on ? "on" : "off"}` }
    await tellSkills()
    if (reply.value.effectiveEnabled !== on)
      return { ok: false, problem: `Codex keeps this skill ${on ? "off" : "on"}` }
    return { ok: true, note: null }
  }

  async function reloadSkills(): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    return (await tellSkills(true)) ? { ok: true, note: null } : { ok: false, problem: "Codex did not list its skills" }
  }

  // Codex reloads every server's config at once; the thread's servers start again from it.
  async function reloadServers(): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    try {
      await within(rpc.request("config/mcpServer/reload", {}), "Codex")
    } catch (error) {
      return { ok: false, problem: problemOf(error) }
    }
    await tellServers()
    return { ok: true, note: null }
  }

  // Codex waits for the browser's answer on a port of its own and says when the login is done.
  async function loginServer(name: string): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    let reply
    try {
      reply = resultOf(
        await within(rpc.request("mcpServer/oauth/login", { name, threadId: session }), "Codex"),
        oauthLogin,
        "mcpServer/oauth/login",
      )
    } catch (error) {
      return { ok: false, problem: problemOf(error) }
    }
    if (reply.kind !== "ok") return { ok: false, problem: `Codex did not start a login for ${name}` }
    if (!webPage(reply.value.authorizationUrl))
      return { ok: false, problem: "Codex gave a login address that is not a web page" }
    if (!(await deps.openUrl(reply.value.authorizationUrl)))
      return { ok: false, problem: "The login page did not open in the browser" }
    return { ok: true, note: "Finish the login in the browser" }
  }

  // Plan keeps the access; an access switch leaves Plan. The mode itself is told when Codex says it changed.
  async function setMode(id: ModeId): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    const listed = fixedMode(id) || (modes ?? (await readModes())).some((row) => row.id === id && row.available)
    const fields = id === PLAN || id === access() ? {} : accessFields(id, now.access.profile !== null)
    if (!listed || fields === null) return { ok: false, problem: `Codex has no mode ${id}` }
    const planning = now.collaboration === PLAN
    if (id === PLAN) return planning ? { ok: true, note: null } : update(collaboration(PLAN, now.model, now.effort))
    const leaving = planning ? collaboration("default", now.model, now.effort) : {}
    if (Object.keys(fields).length === 0 && !planning) return { ok: true, note: null }
    return update({ ...fields, ...leaving })
  }

  async function setModel(choice: ModelRef): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    if (choice.provider !== null && choice.provider !== now.provider)
      return { ok: false, problem: `Codex runs another provider's models in a new session only` }
    if (catalog === null) await tellModels()
    if (!catalog?.some((model) => model.id === choice.id))
      return { ok: false, problem: `Codex has no model ${choice.id}` }
    return choice.id === now.model ? { ok: true, note: null } : update({ model: choice.id }, true)
  }

  // No level is the model's own default.
  async function setEffort(level: EffortId | null): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    if (catalog === null) await tellModels()
    const model = catalog?.find((row) => row.id === now.model)
    const wanted = level ?? model?.defaultReasoningEffort ?? null
    if (wanted === null || wanted === effort()) return { ok: true, note: null }
    if (model && !model.supportedReasoningEfforts.some((row) => row.reasoningEffort === wanted))
      return { ok: false, problem: `Codex has no effort ${wanted} for this model` }
    return update({ effort: wanted }, true)
  }

  // Shown thinking is Codex's reasoning summary, for this session only.
  async function setThinking(shown: boolean): Promise<Outcome> {
    if (shown === thinking) return { ok: true, note: null }
    const outcome = await update({ summary: shown ? "auto" : "none" }, true)
    if (outcome.ok) thinking = shown
    return outcome
  }

  if (chosen === PLAN || (chosen !== null && options.resume && chosen !== mode())) await setMode(chosen)

  // Text and images; commands and kept text wait for their caps. Thinking shows as Codex's reasoning summary. During
  // a turn the prompt is steered into it, or queued.
  async function send(prompt: Prompt): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    if (cuts.pending() !== null) {
      const back = await cuts.goBack(null)
      if (!back.ok) return back
    }
    await settling
    if (prompt.command?.name === "compact") return compact(prompt)
    // A /compact whose turn never came must not show in this prompt's turn.
    translator.compacting(null)
    try {
      await delivery.send(prompt, [...inputOf(prompt), ...skillOf(prompt)], thinking ? "auto" : "none")
      return { ok: true, note: null }
    } catch (error) {
      return { ok: false, problem: problemOf(error) }
    }
  }

  // A skill typed as a command goes along with the text, which keeps the command as typed.
  function skillOf(prompt: Prompt): unknown[] {
    const name = prompt.command?.name
    const skill = name ? skills?.find((row) => row.enabled && row.command === name) : undefined
    return skill ? [{ type: "skill", name: skill.name, path: skill.id }] : []
  }

  // Codex runs the compaction as a turn of its own, which shows the prompt.
  async function compact(prompt: Prompt): Promise<Outcome> {
    if (translator.running() !== null) return { ok: false, problem: "Codex compacts between turns only" }
    if (prompt.command?.args) return { ok: false, problem: "Codex's /compact takes no instructions" }
    translator.compacting({ id: prompt.id, text: prompt.text })
    try {
      await within(rpc.request("thread/compact/start", { threadId: session }), "Codex")
      return { ok: true, note: null }
    } catch (error) {
      translator.compacting(null)
      return { ok: false, problem: problemOf(error) }
    }
  }

  // Codex says the new name back, which the chat takes as the title.
  async function rename(title: string): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    if (title === named) return { ok: true, note: null }
    try {
      await within(rpc.request("thread/name/set", { threadId: session, name: title }), "Codex")
      named = title
      return { ok: true, note: null }
    } catch (error) {
      log.warn("codex: rename failed", problemOf(error))
      return { ok: false, problem: problemOf(error) }
    }
  }

  // The turn's end comes as its own notification.
  async function interrupt(): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    const turn = translator.running()
    if (turn === null) return { ok: false, problem: IDLE }
    interrupting = turn
    tell({ type: "interrupt", state: "asked", at: lastAt })
    try {
      await within(rpc.request("turn/interrupt", { threadId: session, turnId: turn }), "Codex")
      tell({ type: "interrupt", state: "answered", at: lastAt })
      return { ok: true, note: null }
    } catch (error) {
      if (interrupting === turn) interrupting = null
      tell({ type: "interrupt", state: "refused", at: lastAt })
      return { ok: false, problem: problemOf(error) }
    }
  }

  // A background shell is terminated, a subagent's turn interrupted.
  async function stopTask(id: TaskId): Promise<Outcome> {
    if (ended || closed) return { ok: false, problem: DOWN }
    const process = translator.shell(id)
    const turn = process === null ? translator.childTurn(id) : null
    if (process === null && turn === null) return { ok: false, problem: "Codex is not running this task" }
    tell(...translator.stopping(id, lastAt))
    try {
      if (process === null) {
        await within(rpc.request("turn/interrupt", { threadId: id, turnId: turn }), "Codex")
        return { ok: true, note: null }
      }
      const reply = resultOf(
        await within(
          rpc.request("thread/backgroundTerminals/terminate", { threadId: session, processId: process }),
          "Codex",
        ),
        terminateResult,
        "thread/backgroundTerminals/terminate",
      )
      if (reply.kind === "ok" && reply.value.terminated) return { ok: true, note: null }
      translator.refused(id)
      return { ok: false, problem: "Codex did not stop the task" }
    } catch (error) {
      translator.refused(id)
      return { ok: false, problem: problemOf(error) }
    }
  }

  // The same thread goes on in a new app-server.
  async function restart(): Promise<Outcome> {
    if (!ended || closed) return { ok: false, problem: "Codex is still running" }
    tell({ type: "starting", at: lastAt })
    try {
      const next = await connect(deps, options.cwd, true)
      try {
        await openThread(next.rpc, {
          ...options,
          resume: { ref: { agent: CODEX, id: session }, fork: false, at: null },
        })
      } catch (error) {
        await next.rpc.close()
        throw error
      }
      rpc = next.rpc
      version = next.version ?? version
      ended = false
      tell({ type: "ready", at: lastAt })
      follow(rpc)
      return { ok: true, note: null }
    } catch (error) {
      const problem = problemOf(error)
      tell({ type: "ended", problem: { text: problem, detail: [] }, at: lastAt })
      return { ok: false, problem }
    }
  }

  return {
    kind: CODEX,
    get session() {
      return { agent: CODEX, id: session }
    },
    version: version ?? detected,
    caps: CODEX_CAPS,
    events: out.items,
    send,
    interrupt,
    answer(id, reply) {
      asks.answer(id, reply)
      return Promise.resolve()
    },
    restart,
    async close() {
      if (closed) return
      closed = true
      await rpc.close()
      asks.gone()
      tell({ type: "ended", problem: null, at: lastAt })
      out.end()
    },
    setMode,
    setModel,
    setEffort,
    setExtraEffort: later("extra effort"),
    setThinking,
    rename,
    cut(before) {
      cuts.cut(before)
      return Promise.resolve({ ok: true, note: null })
    },
    undoCut() {
      cuts.undo()
      return Promise.resolve({ ok: true, note: null })
    },
    goBack: (before) => cuts.goBack(before),
    refresh,
    tasks: { stop: stopTask, background: later("background now") },
    mcp: { toggle: later("MCP on and off"), reconnect: () => reloadServers(), login: loginServer },
    skills: { toggle: toggleSkill, reload: reloadSkills },
    plugins: { toggle: later("plugins on and off"), reload: later("plugin reload") },
    permissions: { remove: later("permissions") },
    settings: {
      rows: () => (ended || closed ? Promise.reject(new Error(DOWN)) : config.rows()),
      write: (id, value) => (ended || closed ? Promise.resolve({ ok: false, problem: DOWN }) : config.write(id, value)),
    },
    context: () => Promise.resolve(contextReport(now.model, translator.meter.used(), translator.meter.window())),
    usage: () => Promise.reject(new Error("Codex usage is not built yet")),
    files: (query) => (ended || closed ? Promise.resolve([]) : findFiles(rpc, opened.cwd, query)),
    setClientTools: later("client tools"),
    setMcpServers: later("MCP servers"),
  }
}

export function startCodex(options: StartOptions, deps: Partial<Deps> = {}): Promise<CodexAgent> {
  return start(options, { ...realDeps, ...deps })
}

export function codexKind(deps: Partial<Deps> = {}): Omit<AgentKind, "start"> & {
  start(options: StartOptions): Promise<CodexAgent>
} {
  const merged = { ...realDeps, ...deps }
  // Checked once per kind, until it fails.
  let checked: Promise<string> | null = null
  // A short-lived app-server for one read; nobody needs to be signed in to read what is on disk.
  async function reading<T>(cwd: string, use: (rpc: Rpc) => Promise<T>): Promise<T> {
    checked ??= usable(merged)
    await checked.catch((error: unknown) => {
      checked = null
      throw error
    })
    const { rpc } = await connect(merged, cwd, false)
    try {
      return await use(rpc)
    } finally {
      await rpc.close()
    }
  }
  return {
    id: CODEX,
    name: CODEX_NAME,
    caps: CODEX_CAPS,
    detect: () => {
      checked = null
      return merged.detect()
    },
    start: (options) => start(options, merged),
    sessions: (cwd) => reading(cwd, (rpc) => listSessions(rpc, cwd)),
    // Any folder will do for reading a thread by its id.
    history: (ref, cursor) => reading(process.cwd(), (rpc) => historyPage(rpc, ref.id, cursor)),
    // No thread is opened, so nothing is kept.
    listModels: (cwd) =>
      reading(cwd, async (rpc) => {
        const { groups } = await readModels(rpc, cwd, await defaultProvider(rpc, cwd))
        return withWindows(groups, cachedWindows())
      }),
    async oneShot(prompt, cwd) {
      try {
        checked ??= usable(merged)
        await checked.catch((error: unknown) => {
          checked = null
          throw error
        })
        const { rpc } = await connect(merged, cwd, true)
        try {
          return await within(answerOnce(rpc, prompt, cwd), "Codex", TITLE_MS)
        } finally {
          await rpc.close()
        }
      } catch (error) {
        log.warn("codex: session title failed", problemOf(error))
        return null
      }
    },
  }
}
