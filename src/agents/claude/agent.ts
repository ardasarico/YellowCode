import { existsSync } from "node:fs"
import { join } from "node:path"
import { createSignal } from "solid-js"
import type {
  Agent,
  AgentKind,
  ClientTool,
  ContextReport,
  Prompt,
  RestartOptions,
  StartOptions,
  UsageReport,
} from "../../agent/agent.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { ModeId, Outcome, PromptId } from "../../agent/ids.ts"
import type { ModelRow } from "../../agent/lists.ts"
import type { SessionEntry, SessionRef } from "../../agent/sessions.ts"
import { log } from "../../log/log.ts"
import { projectKey } from "../../project-key.ts"
import {
  contextUsage,
  effectiveSettings,
  reloadSkillsReply,
  rewindConversationReply,
  usageReply,
} from "../../protocol/messages.ts"
import {
  backgroundTasksRequest,
  getContextUsageRequest,
  getSettingsRequest,
  getUsageRequest,
  interruptRequest,
  keptReply,
  promptLines,
  reloadSkillsRequest,
  renameSession,
  rewindConversationRequest,
  shellContext,
  userMessage,
} from "../../protocol/outgoing.ts"
import { agentMessage } from "../../session/agent-message.ts"
import { hiddenPrompts, rewoundTasks } from "../../session/rewind.ts"
import type { SessionStore } from "../../session/session.ts"
import type { Ask } from "../../session/types.ts"
import type { Spawn } from "../../source/claude-args.ts"
import type { Recording } from "../../source/recording.ts"
import type { Speed } from "../../source/replay.ts"
import { isEffort, type Knobs, modelIdOf } from "../../source/controls.ts"
import { accepts, connect, type Connection } from "../../source/live.ts"
import { answerAsk } from "./answers.ts"
import { CLAUDE, CLAUDE_CAPS, CLAUDE_NAME, CLAUDE_SHORT_NAME } from "./caps.ts"
import { detect } from "./detect.ts"
import { fileHistory } from "./file-history.ts"
import { claudeFiles } from "./files.ts"
import { heldElsewhere } from "./held.ts"
import { BLOCKED_COMMANDS, isClaudeMode } from "./lists.ts"
import { toolPrefix } from "./mcp-rows.ts"
import { listModels } from "./models.ts"
import { oneShot } from "./one-shot.ts"
import { CLAUDE_PROJECTS, projectFolder, realPath } from "./projects.ts"
import type { LiveProvider } from "./provider.ts"
import { listSessions, type TranscriptEntry } from "./session-list.ts"
import { settingChange, settingMessage, settingRows } from "./settings.ts"
import { historyPage, promptParent } from "./transcript.ts"
import { type ClaudeReplay, claudeReplay } from "./replay.ts"
import { endSession, interruptFailed, restartSession, showEarly } from "./translate.ts"

// What index.tsx still reaches beyond the neutral Agent, as hooks an agent of another kind does not have; contract.md
// gives the stage each of these goes in.
export type ClaudeHooks = {
  // The claude of the moment, compared by identity: a restart, a rewind's restart or another session changes it.
  readonly run: object
  // True while an old claude of this agent ends before the next one starts.
  readonly restarting: boolean
  // Reads claude's lines from here on. The first claude starts before the terminal check and waits for it.
  begin(): void
  // False once the claude of the moment has exited or its pipe closed.
  accepts(): boolean
  // `restart` with the outcome at once when nothing had to wait, for App.onRestart's synchronous answer.
  restartNow(options: RestartOptions): Outcome | Promise<Outcome>
  // How many days claude keeps sessions (its cleanupPeriodDays), asked once the first claude is initialized; null
  // when it does not say. Never settles for a claude that does not initialize.
  sessionDays(): Promise<number | null>
  // Takes the cut now, so the chat shows the next prompt only once the conversation went back. Not ok: nothing went
  // out; `problem` is null when there is nothing to tell (claude did not start again, or the agent is no longer used).
  goBack(options: RestartOptions): Promise<Back>
}

export type ClaudeAgent = Agent & ClaudeHooks

// Claude in the registry. `start` and `replay` take the store the connection or the recording feeds until the store
// reads `events`.
export type ClaudeKind = Pick<AgentKind, "id" | "name" | "shortName" | "caps" | "detect" | "sessions" | "history"> &
  Required<
    Pick<AgentKind, "heldElsewhere" | "oneShot" | "listModels" | "fileHistory" | "settingChange" | "settingMessage">
  > & {
    start(options: StartOptions, store: SessionStore): Promise<ClaudeAgent>
    replay(recording: Recording, speed: Speed, store: SessionStore): ClaudeReplay
  }

// What the app hands every Claude agent it starts.
type Bridge = {
  provider: LiveProvider
  // Runs before a yes to a main-agent call goes out, which waits for it.
  beforeAllow?: (ask: Ask) => Promise<void> | undefined
}

const entryOf = (entry: TranscriptEntry): SessionEntry => ({
  ref: { agent: CLAUDE, id: entry.id },
  title: entry.title,
  firstPrompt: entry.firstPrompt,
  cwd: entry.cwd,
  branch: entry.branch,
  model: entry.model === null ? null : { provider: null, id: entry.model },
  modified: entry.modified,
})

// `folder` lists the transcripts of a folder of claude's projects in place of the cwd's own (--sessions).
export function claudeKind(bridge: Bridge, folder: string | null = null): ClaudeKind {
  // Where each listed session's transcript is.
  const transcripts = new Map<string, string>()
  const transcriptOf = (ref: SessionRef) => {
    const path = transcripts.get(ref.id)
    if (path === undefined) throw new Error(`session ${ref.id} was not listed`)
    return path
  }
  // A folder resolves as it did the first time it was listed, so one that goes away later still lists.
  const resolved = new Map<string, string>()
  const realOf = (cwd: string) => {
    const real = resolved.get(cwd) ?? realPath(cwd)
    resolved.set(cwd, real)
    return real
  }
  return {
    id: CLAUDE,
    name: CLAUDE_NAME,
    shortName: CLAUDE_SHORT_NAME,
    caps: CLAUDE_CAPS,
    detect,
    async sessions(cwd) {
      const real = folder ? null : realOf(cwd)
      const listed = await listSessions(folder ?? join(CLAUDE_PROJECTS, projectKey(real ?? cwd)), real)
      for (const entry of listed) transcripts.set(entry.id, entry.path)
      return listed.map(entryOf)
    },
    history: (ref, cursor) => Promise.try(() => historyPage(transcriptOf(ref), cursor)),
    heldElsewhere: (ref) => heldElsewhere(ref.id),
    oneShot,
    listModels,
    settingChange,
    settingMessage,
    fileHistory: (ref, wanted) => Promise.try(() => fileHistory(ref, transcriptOf(ref), wanted)),
    start: (options, store) => Promise.try(() => startClaude(options, store, bridge)),
    replay: claudeReplay,
  }
}

type Back = { ok: true } | { ok: false; problem: string | null }

const ok: Outcome = { ok: true, note: null }
const problemOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const failed = (error: unknown): Outcome => ({ ok: false, problem: problemOf(error) })
const outcome = (work: Promise<unknown>): Promise<Outcome> =>
  work.then((note) => ({ ok: true, note: typeof note === "string" ? note : null }), failed)
// Intents whose Claude side still lives in the UI or index.tsx; their S3 areas move it here.
const notMoved = (intent: string) => `${intent} does not go through the agent yet`
const notYet = (intent: string): Outcome => ({ ok: false, problem: notMoved(intent) })

export const transcriptPath = (cwd: string, id: string) => join(projectFolder(CLAUDE_PROJECTS, cwd), `${id}.jsonl`)

// claude reads a command from the text itself; a message for a subagent goes in the envelope that has claude pass it on.
const promptText = (prompt: Pick<Prompt, "text" | "to">) =>
  prompt.to ? agentMessage(prompt.to.task, prompt.to.name, prompt.text) : prompt.text

// The prompt in the chat at Enter, before its line goes out (the store's showEarly, until the store takes the Prompt).
export function showPrompt(store: SessionStore, prompt: Prompt): void {
  showEarly(store, userMessage(promptText(prompt), prompt.images, prompt.id))
}

// The turn claude starts by itself after a rewind is never shown, so a failed interrupt of it only goes to the log.
function interruptHidden(live: Connection): void {
  void live.requests.send(interruptRequest).then(
    (reply) => log.info("hidden turn interrupted", reply),
    (error: unknown) => log.warn("hidden turn not interrupted", error instanceof Error ? error.message : error),
  )
}

// A turn a kept background task starts can come in between: claude refuses while it is queued (commands_queued) or
// runs (turn_running), so the step waits for it and asks again.
const BUSY_REASONS = new Set(["turn_running", "commands_queued"])

// claude takes no rewind while a turn runs, such as one a kept background task started.
async function idle(live: Connection): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop
  while (live.session.state.status === "running" && accepts(live)) await Bun.sleep(100)
}

async function stepOnce(live: Connection, uuid: string, tries = 10) {
  const reply = await live.requests
    .send((requestId) => rewindConversationRequest(requestId, uuid))
    .catch((error: unknown) => ({ rewound: false, error: problemOf(error) }))
  const answer = rewindConversationReply.safeParse(reply).data
  if (!BUSY_REASONS.has(answer?.reason ?? "") || tries <= 1) return answer
  await Bun.sleep(200)
  await idle(live)
  return stepOnce(live, uuid, tries - 1)
}

// claude takes only its latest remaining prompt, so it steps back over each, newest first. False at the first one it
// does not take.
async function stepBack(live: Connection, uuids: string[]): Promise<boolean> {
  for (const uuid of uuids) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time, each needs the one before
    const answer = await stepOnce(live, uuid)
    if (!answer?.rewound) {
      log.warn("claude did not rewind the conversation", { error: answer?.error, reason: answer?.reason })
      return false
    }
  }
  return true
}

function contextReport(reply: unknown): ContextReport {
  const parsed = contextUsage.safeParse(reply)
  if (!parsed.success) throw new Error("unexpected reply")
  const usage = parsed.data
  return {
    model: usage.model,
    used: usage.totalTokens,
    window: usage.maxTokens,
    categories: usage.categories.map((category) => {
      const id = category.id ?? category.name
      return {
        id,
        name: category.name,
        tokens: category.tokens,
        kind: category.kind === "used" || category.kind === "free" ? category.kind : "other",
        holds: id === "memory_files" ? "files" : id === "mcp_tools" ? "tools" : null,
      }
    }),
    files: usage.memoryFiles.map(({ path, tokens }) => ({ path, tokens })),
    tools: usage.mcpTools.map(({ name, serverName, tokens }) => ({
      name: name.replace(toolPrefix(serverName), ""),
      server: serverName,
      tokens,
    })),
  }
}

function usageReport(reply: unknown): UsageReport {
  const parsed = usageReply.safeParse(reply)
  if (!parsed.success) throw new Error("unexpected reply")
  const { session, subscription_type } = parsed.data
  return {
    costUsd: session.total_cost_usd,
    apiMs: session.total_api_duration_ms,
    wallMs: session.total_duration_ms,
    linesAdded: session.total_lines_added,
    linesRemoved: session.total_lines_removed,
    models: Object.entries(session.model_usage).map(([model, tokens]) => ({
      model,
      input: tokens.inputTokens,
      output: tokens.outputTokens,
      cacheRead: tokens.cacheReadInputTokens,
      cacheWrite: tokens.cacheCreationInputTokens,
    })),
    plan: subscription_type ?? null,
  }
}

function permissionOf(id: ModeId): ModeId {
  if (!isClaudeMode(id)) throw new Error(`Claude Code has no permission mode ${id}`)
  return id
}

// The saved thinking display and mode claude starts with.
const storedOf = (options: RestartOptions) => ({
  thinking: options.thinking ? ("summarized" as const) : ("hidden" as const),
  permissionMode: permissionOf(options.defaultMode ?? "default"),
})

// A new session gets its id from here, so it is known before claude reports it; a copy gets one of its own.
function spawnOf(resume: StartOptions["resume"]): Spawn {
  if (resume === null) return { sessionId: crypto.randomUUID() }
  const at = resume.at === null ? {} : { at: resume.at }
  return resume.fork
    ? { resume: resume.ref.id, ...at, fork: true, sessionId: crypto.randomUUID() }
    : { resume: resume.ref.id, ...at }
}

// Without a model, effort or ultracode claude starts with its own.
function carryOf(options: StartOptions, models: ModelRow[]): Knobs | undefined {
  const { model, effort, extraEffort } = options
  if (model === null && effort === null && !extraEffort) return undefined
  if (effort !== null && !isEffort(effort)) throw new Error(`Claude Code has no effort ${effort}`)
  return { model: model === null ? null : modelIdOf(models, model.id), effort, ultracode: extraEffort }
}

// Spawns claude for the store; nothing is read until `begin`. claude takes YellowCode's own instructions and the mods'
// manifest servers by itself, so `instructions` and `mcpServers` are not read yet.
function startClaude(options: StartOptions, store: SessionStore, bridge: Bridge): ClaudeAgent {
  const { cwd } = options
  const { provider } = bridge
  // Every claude this agent starts serves them, as SDK MCP servers.
  const [clientTools, setClientTools] = createSignal<readonly ClientTool[]>(options.clientTools)
  const carried = carryOf(options, provider.models())
  // What the knobs show: what was picked last, or what claude said it uses. A claude started again gets them.
  const knobs: Knobs = { model: null, effort: null, ultracode: false, ...carried }
  const onKnobs = (change: Partial<Knobs>) => Object.assign(knobs, change)
  let current = connect({
    cwd,
    session: store,
    spawn: spawnOf(options.resume),
    stored: storedOf(options),
    provider,
    carry: carried,
    onKnobs,
    mode: options.mode === null ? undefined : permissionOf(options.mode),
    clientTools,
  })
  const initialized = Promise.withResolvers<void>()
  current.controls.follow({ initialized: () => initialized.resolve(), onMessage: () => {} })
  const closed = Promise.withResolvers<void>()
  let shut = false
  // What the last /reload-skills of this conversation reported; claude's other lists hold a different set, so only a
  // reload says which are new.
  let reloaded: { conversation: number; names: Set<string> } | null = null
  // A command has to start its message, so what claude should hear again and the `!` commands wait for the next one.
  let heldReplies: { conversation: number; replies: string[] } | null = null
  let heldShells: Prompt["shells"] = []
  let restarting = false
  // Claudes asked to stop that may still run, with the promise of each being gone.
  const ending = new Map<Connection, Promise<void>>()

  function end(old: Connection): Promise<void> {
    let gone = ending.get(old)
    if (!gone) {
      gone = old.close().finally(() => ending.delete(old))
      ending.set(old, gone)
    }
    return gone
  }

  // A claude this agent leaves writes its transcript until it ends, so the next one waits for it. False when the next
  // one must not start: the agent was closed, or another claude took over meanwhile.
  async function leave(old: Connection): Promise<boolean> {
    restarting = true
    await end(old)
    restarting = false
    return !shut && current === old
  }

  function respawn(saved: RestartOptions, spawn?: Spawn): Outcome {
    const id = store.state.info?.id
    // With nothing on disk the start is repeated, under a new id in case claude took the old one.
    const again = current.spawn.sessionId ? { ...current.spawn, sessionId: crypto.randomUUID() } : current.spawn
    const next = spawn ?? (id !== undefined && existsSync(transcriptPath(cwd, id)) ? { resume: id } : again)
    const carry = { ...knobs }
    try {
      // The session goes on in the mode it was in (a plan mode claude entered, edits allowed for the session) unless
      // the app names one.
      const { permissionMode } = store.state
      const kept = permissionMode !== null && isClaudeMode(permissionMode) ? permissionMode : undefined
      const mode = saved.mode === null ? kept : permissionOf(saved.mode)
      current = connect({
        cwd,
        session: store,
        spawn: next,
        stored: storedOf(saved),
        provider,
        carry,
        onKnobs,
        mode,
        clientTools,
      })
    } catch (error) {
      log.error("cannot start claude", error)
      endSession(store, { text: "Cannot start Claude Code", detail: [problemOf(error)] })
      return failed(error)
    }
    restartSession(store)
    current.start()
    return ok
  }

  // A new claude continues the same conversation where the last one left off. One that stopped responding can still be
  // running out its grace; a second claude must not write the same file meanwhile, so the start waits for it.
  function restartNow(saved: RestartOptions): Outcome | Promise<Outcome> {
    if (shut) return { ok: false, problem: "Claude Code was closed" }
    const ended = current
    const { code, signal } = ended.source.exitNow()
    if (code === null && signal === null) {
      restartSession(store)
      return leave(ended).then((go) =>
        go ? respawn(saved) : { ok: false, problem: "Claude Code was closed before it started again" },
      )
    }
    void end(ended)
    return respawn(saved)
  }

  const sessionId = (live: Connection) => store.state.info?.id ?? live.spawn.sessionId ?? live.spawn.resume

  // The store's hidden span is the cut until the store learns of cuts from `cut` events. It goes back in the running
  // claude, else in one started again at what the first hidden prompt hangs from.
  async function goBack(saved: RestartOptions): Promise<Back> {
    const prompts = hiddenPrompts(store.state)
    if (prompts.length === 0) return ok
    const live = current
    await idle(live)
    const uuids = prompts.filter((uuid): uuid is string => uuid !== undefined)
    if (uuids.length === prompts.length && (await stepBack(live, uuids))) {
      log.info("conversation rewound", { prompts: uuids.length })
      return ok
    }
    const id = sessionId(live)
    const first = prompts.at(-1)
    const at = id && first ? await promptParent(transcriptPath(cwd, id), first) : undefined
    if (!id || at === undefined) return { ok: false, problem: "Cannot rewind the conversation to this prompt" }
    log.info("conversation rewound by a restart", { at })
    if (!(await leave(live))) return { ok: false, problem: null }
    const spawn = at === null ? { sessionId: crypto.randomUUID() } : { resume: id, at }
    return respawn(saved, spawn).ok ? ok : { ok: false, problem: null }
  }

  return {
    kind: CLAUDE,
    get session() {
      return { agent: CLAUDE, id: sessionId(current) ?? "" }
    },
    get version() {
      return store.state.info?.cliVersion ?? ""
    },
    caps: CLAUDE_CAPS,
    // The connection feeds the store itself, so nothing comes out here yet.
    events: {
      [Symbol.asyncIterator]: () => ({
        next: () => closed.promise.then((): IteratorResult<AgentEvent> => ({ done: true, value: undefined })),
      }),
    },
    get run() {
      return current
    },
    get restarting() {
      return restarting
    },
    begin: () => current.start(),
    accepts: () => accepts(current),
    sessionDays: () =>
      initialized.promise
        .then(() => current.requests.send(getSettingsRequest))
        .then((reply) => {
          const days = effectiveSettings.safeParse(reply).data?.effective.cleanupPeriodDays
          return typeof days === "number" && days > 0 ? days : null
        }),
    goBack,
    // The contract's pending cut is `goBack`'s until S5: index.tsx takes it before the prompt shows, so the send
    // leaves it alone.
    send(prompt) {
      const live = current
      // A knob change still waiting goes first, so the message runs under it.
      live.controls.flush()
      const { conversation } = store.state
      const replies = [...(heldReplies?.conversation === conversation ? heldReplies.replies : []), ...prompt.kept]
      const shells = [...heldShells, ...prompt.shells]
      heldReplies = null
      heldShells = []
      const command = prompt.to === null && prompt.text.startsWith("/")
      if (command) {
        if (replies.length > 0) heldReplies = { conversation, replies }
        heldShells = shells
      }
      const told = command ? [] : replies.map(keptReply)
      const after = command ? [] : shells.map((shell) => shellContext(shell.command, shell.output))
      const { sent } = promptLines(promptText(prompt), prompt.images, prompt.id, told, after)
      if (live.source.send(sent)) return Promise.resolve(ok)
      return Promise.resolve({ ok: false, problem: "Claude Code stopped before the message went out" })
    },
    interrupt() {
      return current.requests.send(interruptRequest).then(
        (reply) => {
          log.info("interrupted", reply)
          return ok
        },
        (error: unknown) => {
          log.warn("interrupt failed", problemOf(error))
          interruptFailed(store)
          return failed(error)
        },
      )
    },
    answer(id, reply) {
      const ask = store.state.byId[`ask-${id}`]
      if (ask?.kind !== "ask") {
        log.warn("answer to an unknown ask", { requestId: id })
        return Promise.resolve()
      }
      const live = current
      // An answer for a claude that went away meanwhile is dropped.
      const send = (line: string) => {
        if (!shut && current === live) live.source.send(line)
      }
      return answerAsk(store, ask, reply, send, bridge.beforeAllow)
    },
    restart: (saved) => Promise.resolve(restartNow(saved)),
    restartNow,
    // Resolves once every claude of this agent has ended.
    async close() {
      shut = true
      closed.resolve()
      void end(current)
      await Promise.all(ending.values())
    },
    // The knobs go out after a short wait, and a refusal comes back as a notice, so each is taken at once.
    setMode(id) {
      if (!isClaudeMode(id)) return Promise.resolve({ ok: false, problem: `Claude Code has no permission mode ${id}` })
      current.controls.setMode(id)
      return Promise.resolve(ok)
    },
    setModel(model) {
      knobs.model = modelIdOf(provider.models(), model.id)
      current.controls.setModel(model.id)
      return Promise.resolve(ok)
    },
    // claude goes on with the level it has when there is none.
    setEffort(effort) {
      if (effort === null) return Promise.resolve(ok)
      if (!isEffort(effort)) return Promise.resolve({ ok: false, problem: `Claude Code has no effort ${effort}` })
      knobs.effort = effort
      current.controls.setEffort(effort, knobs.ultracode)
      return Promise.resolve(ok)
    },
    setExtraEffort(on) {
      knobs.ultracode = on
      current.controls.setUltracode(on)
      return Promise.resolve(ok)
    },
    setThinking(shown) {
      current.controls.setThinking(shown)
      return Promise.resolve(ok)
    },
    // A title claude already has (our last rename, or the user's /rename of the same words) is not written again.
    rename(title) {
      // claude reports the session id with the first init; a title that comes earlier waits for the next message's.
      const id = store.state.info?.id
      if (!id || store.state.agentTitle === title) return Promise.resolve(ok)
      return current.requests
        .send((requestId) => renameSession(requestId, title, id))
        .then(
          () => {
            log.info("renamed session", { id })
            return ok
          },
          (error: unknown) => {
            log.warn("rename failed", problemOf(error))
            return failed(error)
          },
        )
    },
    // The store's rewind holds the cut and its redo takes it back (see goBack). claude starts a turn by itself when a task
    // from the cut prompts ends, or at once when one is stopped; that turn is interrupted and never shown.
    cut(before: PromptId) {
      const from = store.state.items.findLast((id) => {
        const item = store.state.byId[id]
        return item?.kind === "user" && item.uuid === before
      })
      if (from === undefined) return Promise.resolve({ ok: false, problem: `Claude Code has no prompt ${before}` })
      const live = current
      store.hideTurnsOf(
        rewoundTasks(store.state, from).map((task) => task.id),
        () => interruptHidden(live),
      )
      return Promise.resolve(ok)
    },
    undoCut: () => Promise.resolve(ok),
    // claude pushes its commands, models, modes and subagents itself.
    refresh(list) {
      if (list === "mcp") current.mcp.refresh()
      else if (list === "skills" || list === "plugins" || list === "loaded" || list === "hooks")
        current.extensions.refresh()
    },
    tasks: {
      stop: (id) => outcome(current.tasks.stop(id)),
      background: () =>
        current.requests.send(backgroundTasksRequest).then(
          () => {
            log.info("sent foreground tasks to the background")
            return ok
          },
          (error: unknown) => {
            log.warn("background failed", problemOf(error))
            return { ok: false, problem: "Claude Code did not send it to the background" }
          },
        ),
    },
    mcp: {
      toggle: (name, on) => outcome(current.mcp.actions.setEnabled(name, on)),
      reconnect: (name) => outcome(current.mcp.actions.reconnect(name)),
      login: (name) => outcome(current.mcp.actions.login(name)),
    },
    skills: {
      toggle(id, on) {
        const label = provider.skills()?.find((entry) => entry.id === id)?.label ?? id
        return outcome(current.extensions.skills.setEnabled({ name: id, label }, on))
      },
      async reload() {
        const before = reloaded?.conversation === store.state.conversation ? reloaded.names : null
        try {
          const reply = await current.requests.send(reloadSkillsRequest)
          const names = (reloadSkillsReply.safeParse(reply).data?.skills ?? [])
            .map((skill) => skill.name)
            .filter((name) => !BLOCKED_COMMANDS.includes(name))
          const fresh = before ? names.filter((name) => !before.has(name)).length : 0
          reloaded = { conversation: store.state.conversation, names: new Set(names) }
          return { ok: true, note: `Skills reloaded · ${names.length}${fresh > 0 ? `, ${fresh} new` : ""}` }
        } catch (error) {
          return failed(error)
        }
      },
    },
    plugins: {
      toggle: (id, on) => outcome(current.extensions.plugins.setEnabled(id, on)),
      reload: () =>
        outcome(
          current.extensions
            .reload()
            .then((added) => (added > 0 ? (added === 1 ? "1 new plugin error" : `${added} new plugin errors`) : null)),
        ),
    },
    // Not known yet whether claude takes a rule removal, so every rule reads as not removable.
    permissions: { remove: () => Promise.resolve({ ok: false, problem: "Claude Code rules cannot be removed here" }) },
    settings: {
      rows: () =>
        current.requests
          .send(getSettingsRequest)
          .then(
            (reply) => effectiveSettings.safeParse(reply).data?.effective ?? {},
            (error: unknown) => {
              log.warn("claude settings for /settings failed", String(error))
              return null
            },
          )
          .then((effective) =>
            settingRows(effective, { model: knobs.model ?? store.state.info?.model ?? null, plan: provider.plan() }),
          ),
      // The app sends the kind's settingMessage as the user's own message instead.
      write: () => Promise.resolve({ ok: false, problem: "Claude Code takes its settings as messages" }),
    },
    context: () => current.requests.send(getContextUsageRequest).then(contextReport),
    usage: () => current.requests.send(getUsageRequest).then(usageReport),
    files: (query) => claudeFiles(current.requests, query),
    setClientTools(tools) {
      setClientTools(tools)
      return Promise.resolve(ok)
    },
    // The mods' manifest servers reach claude through the mod host for now.
    setMcpServers: () => Promise.resolve(notYet("MCP servers")),
  }
}
