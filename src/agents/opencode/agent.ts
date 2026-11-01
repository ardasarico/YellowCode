import { lstat } from "node:fs/promises"
import { z } from "zod"
import { appVersion } from "../../build-info.ts"
import type { Agent, AgentKind, Detection, Prompt, StartOptions } from "../../agent/agent.ts"
import type { AskReply } from "../../agent/ask.ts"
import type { AgentEvent } from "../../agent/events.ts"
import type { AskId, EffortId, ModeId, ModelRef, Outcome, PromptId } from "../../agent/ids.ts"
import type { SettingValue } from "../../agent/settings.ts"
import type { ListName, Lists, ModelGroup } from "../../agent/lists.ts"
import { log } from "../../log/log.ts"
import { formReply, permissionReply } from "./asks.ts"
import { OPENCODE, OPENCODE_CAPS, OPENCODE_NAME } from "./caps.ts"
import { createCuts, type Revert } from "./cut.ts"
import { detect, findBinary } from "./detect.ts"
import { historyPage } from "./history.ts"
import {
  DEFAULT_VARIANT,
  findFiles,
  readCommands,
  readMcp,
  readModels,
  readPlugins,
  readSkills,
  savedRules,
} from "./lists.ts"
import { readModes } from "./modes.ts"
import { startOwnMcp } from "./own-mcp.ts"
import { commandBody, messageOf, promptBody } from "./prompts.ts"
import { resync, shellOutput } from "./resync.ts"
import { projectFolder, settingRows, writeSetting } from "./settings.ts"
import { findService } from "./service.ts"
import { listSessions } from "./sessions.ts"
import { eventStream, realClock, type Clock } from "./sse.ts"
import { answerOnce } from "./titles.ts"
import { createTranslator, type Translator, type WireModel } from "./translate.ts"
import { channel, httpTransport, type Endpoint, type Transport } from "./transport.ts"
import { contextReport, defaultModel, defaultRef, readLimits, readWindows } from "./usage.ts"
import { answerOf, dataOf, rawPage, rowsOf } from "./wire/envelope.ts"
import { createEventReader } from "./wire/events.ts"
import { message } from "./wire/messages.ts"
import { matches, session as sessionSchema, type Rule, type Session } from "./wire/session.ts"

const START_MS = 15_000
// How long a revert request waits for its event.
const REVERT_MS = 15_000
// opencode reads its config again a moment after a write, and says so with config.updated.
const CONFIG_MS = 3000
const GONE = { text: "opencode stopped responding", detail: [] }
const BUSY = "opencode is busy"
// The lists read on request and again on opencode's word that one changed.
type Watched = "commands" | "skills" | "mcp" | "plugins"
const CHANGED: Partial<Record<string, Watched>> = {
  "command.updated": "commands",
  "skill.updated": "skills",
  "mcp.status.changed": "mcp",
  "plugin.updated": "plugins",
}

export type Deps = {
  detect(): Promise<Detection>
  binary(): string | null
  service(binary: string): Promise<Endpoint>
  transport(endpoint: Endpoint, directory: string): Transport
  clock: Clock
  // What our own MCP server tells opencode it is.
  appVersion: string
  // A plan file's text; null when it cannot be read.
  readFile(path: string): Promise<string | null>
}

const realDeps: Deps = {
  detect: () => detect(),
  binary: () => findBinary(),
  service: (binary) => findService(binary),
  transport: (endpoint, directory) => httpTransport(endpoint, directory),
  clock: realClock,
  appVersion: appVersion,
  // A link in the plan folder could lead anywhere, so only a plain file is read.
  readFile: (path) =>
    lstat(path)
      .then((found) => (found.isFile() ? Bun.file(path).text() : null))
      .catch(() => null),
}

// `connected`, for tests and the recorder: resolves once the stream has connected `count` times and no resync runs.
// `goBack` takes the pending cut now, at `before`, the oldest prompt the chat hides (null: it hides none), so the
// chat shows the next prompt only once the conversation went back. Not ok: the prompt must not go out.
export type OpencodeAgent = Agent & {
  connected(count: number): Promise<void>
  goBack(before: PromptId | null): Promise<{ ok: true } | { ok: false; problem: string }>
}

const notYet = (what: string): Outcome => ({ ok: false, problem: `opencode ${what} is not built yet` })
const later = (what: string) => () => Promise.resolve(notYet(what))

const notInstalled = (): never => {
  throw new Error("opencode is not installed")
}

const created = dataOf(sessionSchema)
const accepted = dataOf(z.looseObject({ id: z.string(), time: z.looseObject({ created: z.number() }) }))
// `interrupted: false` when no turn was running.
const interruptReply = z.looseObject({ interrupted: z.boolean() })

// Our own ask stands in for opencode's question tool, which this rule takes off the session's tools while YellowCode
// has the session open.
const QUESTION_DENY: Rule = { action: "question", resource: "*", effect: "deny" }
// How long leaving a session waits for the question rule to come off.
const LEAVE_MS = 3000

const plain = ({ action, resource, effect }: Rule): Rule => ({ action, resource, effect })
const isQuestionDeny = (rule: Rule) =>
  rule.action === QUESTION_DENY.action &&
  rule.resource === QUESTION_DENY.resource &&
  rule.effect === QUESTION_DENY.effect

// Refuses an agent that is not installed, or one YellowCode cannot speak, before any service call.
async function usable(deps: Deps): Promise<{ version: string; binary: string }> {
  const found = await deps.detect()
  if (!found.installed) return notInstalled()
  if (found.blocked) throw new Error(found.blocked)
  return { version: found.version, binary: deps.binary() ?? notInstalled() }
}

// The session `start` makes, in `agent` when given, attaches to or forks; it rejects with opencode's own words.
async function sessionFor(transport: Transport, options: StartOptions, agent: ModeId | null): Promise<Session> {
  const { resume } = options
  const reply = await transport
    .request(
      resume === null
        ? // The service puts a session where the body says, not where the directory header says.
          {
            method: "POST",
            path: "/api/session",
            body: {
              location: { directory: options.cwd },
              permissions: [QUESTION_DENY],
              ...(agent === null ? {} : { agent }),
            },
          }
        : resume.fork
          ? {
              method: "POST",
              path: `/api/session/${resume.ref.id}/fork`,
              body: resume.at ? { before: messageOf(resume.at) } : {},
            }
          : { method: "GET", path: `/api/session/${resume.ref.id}` },
    )
    .catch(() => null)
  const made = reply ? answerOf(reply, created, "session") : null
  if (made?.kind === "ok") return made.value.data
  throw new Error(made?.kind === "error" && made.message ? made.message : "opencode did not give the session")
}

// A session opened again or copied keeps its rules; the question rule is added where the last word on questions is
// not ours. opencode applies the last rule that matches, and replaces the session's rules with the list sent.
async function denyQuestions(transport: Transport, info: Session): Promise<void> {
  const rules = (info.permissions ?? []).map(plain)
  const last = rules.findLast((rule) => matches(rule.action, QUESTION_DENY.action))
  if (last && isQuestionDeny(last)) return
  const reply = await transport
    .request({ method: "PATCH", path: `/api/session/${info.id}`, body: { permissions: [...rules, QUESTION_DENY] } })
    .catch(() => null)
  if (reply?.status !== 204 && reply?.status !== 200) log.warn("opencode: the question rule did not go on the session")
}

// Leaving the session gives opencode's question tool back to it, keeping the rules as they are now.
async function allowQuestions(transport: Transport, id: string): Promise<void> {
  const reply = await transport.request({ method: "GET", path: `/api/session/${id}` }).catch(() => null)
  const asked = reply ? answerOf(reply, created, "session") : null
  if (asked?.kind !== "ok") return
  const rules = (asked.value.data.permissions ?? []).map(plain)
  const kept = rules.filter((rule) => !isQuestionDeny(rule))
  if (kept.length === rules.length) return
  const done = await transport
    .request({ method: "PATCH", path: `/api/session/${id}`, body: { permissions: kept } })
    .catch(() => null)
  if (done?.status !== 204 && done?.status !== 200) log.warn("opencode: the question rule did not come off the session")
}

// One session on opencode's shared service. Events of other sessions are seen and dropped.
async function connect(options: StartOptions, deps: Deps): Promise<OpencodeAgent> {
  const found = await usable(deps)
  const binary = found.binary

  const out = channel<AgentEvent>()
  const translator: Translator = createTranslator()
  let transport = deps.transport(await deps.service(binary), options.cwd)
  let stream = new AbortController()
  let session: string | null = null
  // The saved rules are read once something asks for them, and kept fresh from then on.
  let rulesAsked = false
  let rulesRead = 0
  // Each watched list once something asked for it: whether a read runs, whether another is due after it, and the list
  // as last told.
  const watched = new Map<Watched, { reading: boolean; again: boolean; told: string }>()
  // The project's folder, read once a list needs it.
  let projectDir: Promise<string> | null = null
  // Settings writes waiting for opencode to read the config of the session's folder again.
  const configWaiters = new Set<() => void>()
  let here = options.cwd
  let readyTold = false
  let ended = false
  // The session itself is gone, so a restart has nothing to connect to.
  let deleted: string | null = null
  let closed = false
  let renamed = false
  let connects = 0
  let resyncing = false
  let lastAt = 0
  let waiters: { count: number; resolve: () => void }[] = []
  // Copies the service has finished, by session id, and the one `start` waits for.
  const forked = new Set<string>()
  let forking: { id: string; resolve: () => void } | null = null
  // The last mode switch; a prompt sent right after it waits, so it runs in the new mode.
  let switching: Promise<unknown> = Promise.resolve()
  // The models as last read, once something asked for them. Model and effort picks go out one at a time, and a prompt
  // waits for them as for a mode switch.
  let models: ModelGroup[] | null = null
  let picking: Promise<unknown> = Promise.resolve()
  const cuts = createCuts((id) => translator.forget(id))
  // Cuts, their undos and commits go out one at a time.
  let reverting: Promise<unknown> = Promise.resolve()
  let queuedReverts = 0

  const settle = () => {
    const ready = waiters.filter((waiter) => connects >= waiter.count && !resyncing)
    waiters = waiters.filter((waiter) => !ready.includes(waiter))
    for (const waiter of ready) waiter.resolve()
  }

  // Tells `events`; when they end the session (deleted from another client) nothing more comes for it. Says if so.
  function tell(events: AgentEvent[]): boolean {
    out.push(...events)
    if (events.some((event) => event.type === "turn.end")) tellLimits()
    const end = events.find((event) => event.type === "ended")
    if (!end) return false
    ended = true
    deleted = end.problem?.text ?? ""
    stream.abort()
    return true
  }

  async function catchUp(at: number): Promise<boolean> {
    if (session === null) return false
    resyncing = true
    try {
      if (tell(await withPlans(await resync(transport, session, translator, cuts, at)))) return true
      // A rule saved while the stream was down.
      if (rulesAsked) await tellRules()
      return false
    } finally {
      resyncing = false
    }
  }

  // A plan's text is its file as it is now.
  async function withPlans(events: AgentEvent[]): Promise<AgentEvent[]> {
    if (!events.some((event) => event.type === "plan")) return events
    return Promise.all(
      events.map(async (event) =>
        event.type === "plan" && event.path !== null ? { ...event, text: await deps.readFile(event.path) } : event,
      ),
    )
  }

  // An answer that a newer read overtook is dropped.
  async function tellRules(): Promise<void> {
    const read = ++rulesRead
    const saved = await savedRules(transport, here)
    if (saved && read === rulesRead && !ended && !closed)
      out.push({ type: "lists", lists: { rules: saved }, at: lastAt })
  }

  const projectOf = () => (projectDir ??= projectFolder(transport, here))

  async function readList(list: Watched): Promise<Partial<Lists> | null> {
    switch (list) {
      case "commands": {
        const rows = await readCommands(transport)
        return rows && { commands: rows }
      }
      case "skills": {
        const rows = await readSkills(transport, await projectOf())
        return rows && { skills: rows }
      }
      case "mcp": {
        const rows = await readMcp(transport)
        return rows && { mcp: rows }
      }
      case "plugins": {
        const rows = await readPlugins(transport, await projectOf())
        return rows && { plugins: rows }
      }
      default:
        return null
    }
  }

  // One read of a list at a time; a word that it changed during a read reads it once more after. A list as it was last
  // told is not told again.
  function tellList(list: Watched): void {
    const known = watched.get(list) ?? { reading: false, again: false, told: "" }
    watched.set(list, known)
    if (known.reading) {
      known.again = true
      return
    }
    known.reading = true
    void readList(list)
      .then((read) => {
        const text = read ? JSON.stringify(read) : known.told
        if (!read || text === known.told || ended || closed) return
        known.told = text
        out.push({ type: "lists", lists: read, at: lastAt })
      })
      .catch((error: unknown) => log.warn(`opencode: could not read the ${list}`, String(error)))
      .finally(() => {
        known.reading = false
        if (!known.again) return
        known.again = false
        tellList(list)
      })
  }

  // A turn spends from the allowance, so it is read again after each.
  function tellLimits(): void {
    void readLimits(transport).then((event) => {
      if (event && !ended && !closed) out.push({ ...event, at: lastAt })
    })
  }

  // Reads one connection's stream until it ends. `first` settles once the stream answers, or fails.
  async function pump(signal: AbortSignal, restarted: boolean, first: PromiseWithResolvers<void>): Promise<void> {
    const read = createEventReader()
    let seq: number | null = null
    let opened = false
    for await (const item of eventStream(transport, signal, deps.clock)) {
      if (item.type === "gone") {
        first.reject(new Error("opencode's service does not answer"))
        if (!opened || closed) return
        ended = true
        out.push(...translator.gone(lastAt), { type: "ended", problem: GONE, at: lastAt })
        return
      }
      const frame = read(item.frame)
      lastAt = frame.at
      // Every durable event of our session counts, the types we do not read too; a skipped number means the stream
      // missed one.
      const durable = frame.durable?.aggregateID === session ? frame.durable.seq : null
      if (durable !== null) {
        if (seq !== null && durable > seq + 1 && (await catchUp(frame.at))) return
        seq = Math.max(seq ?? durable, durable)
      }
      if (frame.kind !== "event") {
        out.push(
          frame.kind === "unknown"
            ? { type: "seen", at: frame.at }
            : { type: "unreadable", what: frame.what, at: frame.at },
        )
        continue
      }
      const event = frame.event
      if (event.type === "server.connected") {
        connects += 1
        if (!readyTold || (restarted && !opened)) out.push({ type: "ready", at: frame.at })
        readyTold = true
        // The stream of a new connection starts now; what it missed comes from the resync.
        if (opened || restarted) own.wake()
        const over = (opened || restarted) && (await catchUp(frame.at))
        // A list's word that it changed is no session event, so a gap in them does not show; a new stream reads them.
        if (!over && (opened || restarted)) for (const list of watched.keys()) tellList(list)
        opened = true
        seq = null
        first.resolve()
        settle()
        if (over) return
        continue
      }
      // opencode reads the config of each folder it has open, and says so for each.
      const folder = event.location?.directory
      const ours = folder === options.cwd || folder === here
      if (event.type === "config.updated" && ours) {
        for (const done of configWaiters) done()
        if (rulesAsked) void tellRules()
      }
      const changed = CHANGED[event.type]
      if (changed && ours && watched.has(changed)) tellList(changed)
      if (event.type === "session.forked") {
        forked.add(event.data.sessionID)
        if (forking?.id === event.data.sessionID) forking.resolve()
      }
      if (session === null || !translator.belongs(event, session)) {
        out.push({ type: "seen", at: frame.at })
        continue
      }
      const { told, passed } = cuts.read(event, session, frame.at)
      const events: AgentEvent[] = told
      try {
        for (const one of passed) events.push(...translator.event(one, frame.at))
      } catch (error) {
        log.error(`opencode: cannot translate ${event.type}`, error)
      }
      if (tell(events.length > 0 ? await withPlans(events) : [{ type: "seen" as const, at: frame.at }])) return
      if (rulesAsked && event.type === "permission.replied" && event.data.reply === "always") await tellRules()
      // A background shell's output stays readable once it exited; a stopped one's is gone.
      if (event.type === "shell.exited" && event.data.status !== "killed" && translator.readable(event.data.id))
        out.push(...(await shellOutput(transport, event.data.id, frame.at)))
    }
  }

  async function open(restarted: boolean): Promise<void> {
    const first = Promise.withResolvers<void>()
    const timer = setTimeout(() => first.reject(new Error("opencode's event stream did not connect")), START_MS)
    void pump(stream.signal, restarted, first)
      .catch((error: unknown) => {
        log.error("opencode: the event pump failed", error)
        first.reject(error)
        if (ended || closed) return
        ended = true
        out.push({ type: "ended", problem: GONE, at: lastAt })
      })
      .finally(settle)
    try {
      await first.promise
    } finally {
      clearTimeout(timer)
    }
  }

  // Opened first, so opencode has the tools by the first prompt.
  const own = startOwnMcp({
    transport: () => transport,
    clock: deps.clock,
    session: () => session,
    subagent,
    down: () => ended,
    version: deps.appVersion,
    tell: (events) => out.push(...events),
    at: () => lastAt,
  })
  own.setTools(options.clientTools)
  await open(false).catch((error: unknown) => {
    stream.abort()
    own.close()
    throw error
  })
  // Read first, so a new session can start in the mode asked for. opencode takes any agent name, so only a listed one
  // goes out.
  const modes = await readModes(transport)
  translator.windows(await readWindows(transport))
  tellLimits()
  const chosen = options.mode ?? (options.resume ? null : options.defaultMode)
  const wanted = chosen !== null && modes?.rows.some((row) => row.id === chosen) ? chosen : null
  const made = await sessionFor(transport, options, options.resume ? null : wanted).catch((error: unknown) => {
    stream.abort()
    own.close()
    out.end()
    throw error
  })
  if (options.resume?.fork) await copied(made.id)
  session = made.id
  // A cut staged earlier is not in the history; it goes for good with the next send.
  if (made.revert) cuts.open(made.revert.messageID)
  translator.within(made.location.directory)
  here = made.location.directory
  const ref = { agent: OPENCODE, id: session }
  // A new session without an agent of its own runs opencode's default, which it lists first.
  if (modes) out.push(...translator.modes(modes, made.agent ?? wanted ?? modes.rows[0]?.id ?? null, lastAt))
  if (options.resume) await denyQuestions(transport, made)
  if (options.resume) await attach(made)
  if (options.resume && wanted !== null && wanted !== made.agent) await setMode(wanted)

  // A subagent of our session, or of one of its subagents.
  async function subagent(id: string): Promise<boolean> {
    const reply = await transport.request({ method: "GET", path: `/api/session/${id}` }).catch(() => null)
    const asked = reply ? answerOf(reply, created, "session") : null
    const parent = asked?.kind === "ok" ? asked.value.data.parentID : undefined
    return parent !== undefined && (parent === session || translator.child(parent))
  }

  // A fork settles once the service says the copy is done.
  async function copied(id: string): Promise<void> {
    if (forked.has(id)) return
    const done = Promise.withResolvers<void>()
    forking = { id, resolve: done.resolve }
    const timer = setTimeout(() => {
      log.warn("opencode: no word that the fork is done")
      done.resolve()
    }, START_MS)
    await done.promise
    clearTimeout(timer)
    forking = null
  }

  // The history shows what the session stored; the translator learns it, so a resync does not tell it again.
  async function attach(info: Session): Promise<void> {
    const reply = await transport
      .request({ method: "GET", path: `/api/session/${info.id}/message`, query: { order: "desc", limit: "20" } })
      .catch(() => null)
    const page = reply ? answerOf(reply, rawPage, "messages") : null
    const messages = page?.kind === "ok" ? rowsOf(page.value.data, message, "message").toReversed() : []
    out.push(
      ...translator.attached({ title: info.title ?? null, model: info.model, cost: info.cost, messages }, lastAt),
    )
  }

  async function setMode(mode: ModeId): Promise<Outcome> {
    if (ended || session === null) return { ok: false, problem: "opencode is not connected" }
    if (!translator.listed(mode)) return { ok: false, problem: `opencode has no agent ${mode}` }
    const sent = transport
      .request({ method: "POST", path: `/api/session/${session}/agent`, body: { agent: mode } })
      .catch(() => null)
    switching = sent
    const reply = await sent
    const answer = reply ? answerOf(reply, z.unknown(), "agent switch") : null
    if (answer?.kind === "ok") return { ok: true, note: null }
    return {
      ok: false,
      problem: answer?.kind === "error" && answer.message ? answer.message : "opencode did not switch the agent",
    }
  }

  async function send(prompt: Prompt): Promise<Outcome> {
    if (ended || session === null) return { ok: false, problem: "opencode is not connected" }
    if (cuts.staged() !== null || queuedReverts > 0) {
      const back = await goBack(null)
      if (!back.ok) return { ok: false, problem: back.problem }
    }
    await switching
    await picking
    await own.attached()
    if (prompt.command) return sendCommand(prompt, prompt.command)
    translator.sending(prompt.id)
    const sent = await transport
      .request({ method: "POST", path: `/api/session/${session}/prompt`, body: promptBody(prompt) })
      .catch(() => null)
    const answer = sent ? answerOf(sent, accepted, "prompt") : null
    if (answer?.kind !== "ok") {
      translator.unsent(prompt.id)
      return {
        ok: false,
        problem: answer?.kind === "error" && answer.message ? answer.message : "opencode did not take the message",
      }
    }
    const { id, time } = answer.value.data
    if (id !== messageOf(prompt.id) && !renamed) {
      renamed = true
      log.warn("opencode: the service gave a prompt another id than the one sent")
    }
    out.push(...translator.sent(prompt, id, time.created))
    return { ok: true, note: null }
  }

  // opencode answers a command with no message id; the message it makes of the command's template shows as typed.
  async function sendCommand(prompt: Prompt, command: { name: string; args: string }): Promise<Outcome> {
    if (session === null) return { ok: false, problem: "opencode is not connected" }
    translator.commanding(prompt)
    const sent = await transport
      .request({ method: "POST", path: `/api/session/${session}/command`, body: commandBody(prompt, command) })
      .catch(() => null)
    const answer = sent ? answerOf(sent, z.unknown(), "command") : null
    if (answer?.kind === "ok") return { ok: true, note: null }
    translator.unsent(prompt.id)
    return {
      ok: false,
      problem: answer?.kind === "error" && answer.message ? answer.message : "opencode did not run the command",
    }
  }

  // One revert request, settled once its event came; a lost event stops the wait after REVERT_MS.
  async function revert(want: Revert, refused: string): Promise<Outcome> {
    if (ended || session === null) return { ok: false, problem: "opencode is not connected" }
    const base = `/api/session/${session}/revert`
    const watch = cuts.watch(want)
    const reply = await transport
      .request(
        want.type === "staged"
          ? { method: "POST", path: `${base}/stage`, body: { messageID: want.message, files: false } }
          : want.type === "cleared"
            ? { method: "DELETE", path: base }
            : { method: "POST", path: `${base}/commit` },
      )
      .catch(() => null)
    const answer = reply ? answerOf(reply, z.unknown(), "revert") : null
    if (answer?.kind !== "ok") {
      watch.drop()
      if (answer?.kind === "error" && answer.message) log.warn(`opencode: revert ${want.type} refused`, answer.message)
      return { ok: false, problem: answer?.kind === "error" && answer.tag === "SessionBusyError" ? BUSY : refused }
    }
    cuts.applied(want)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), REVERT_MS)))
    const settled = await Promise.race([watch.settled, late]).finally(() => clearTimeout(timer))
    if (settled === "late") {
      watch.drop()
      log.warn(`opencode: no word that the revert was ${want.type}`)
    }
    return { ok: true, note: null }
  }

  function queueRevert<T>(work: () => Promise<T>): Promise<T> {
    queuedReverts += 1
    const done = reverting.then(work).finally(() => (queuedReverts -= 1))
    reverting = done.catch(() => {})
    return done
  }

  const cut = (before: PromptId) =>
    queueRevert(() =>
      revert({ type: "staged", message: translator.messageFor(before) }, "opencode did not cut the conversation"),
    )

  const undoCut = () =>
    queueRevert(() =>
      cuts.staged() === null
        ? Promise.resolve({ ok: true as const, note: null })
        : revert({ type: "cleared" }, "opencode did not bring the conversation back"),
    )

  // The cut goes in at `before`, staged again if opencode does not hold it (it refused it, or the stage was cleared
  // since), and the conversation loses it for good. opencode would commit any stage with the next prompt, so one
  // the chat does not hide is cleared, unless the session was opened with it.
  function goBack(before: PromptId | null): Promise<{ ok: true } | { ok: false; problem: string }> {
    return queueRevert(async () => {
      const staged = cuts.staged()
      if (before === null && staged !== null && cuts.opened() === null) {
        const cleared = await revert({ type: "cleared" }, "opencode did not bring the conversation back")
        return cleared.ok ? { ok: true } : cleared
      }
      const target = before === null ? staged : translator.messageFor(before)
      // Another client may have committed it already.
      if (target === null || cuts.deleted(target)) return { ok: true }
      const refused = "Cannot rewind the conversation to this prompt"
      if (staged !== target) {
        const done = await revert({ type: "staged", message: target }, refused)
        if (!done.ok) return done
      }
      const done = await revert({ type: "committed", message: target }, refused)
      return done.ok ? { ok: true } : done
    })
  }

  // The turn's end comes as its own event, with the text streamed so far. A prompt steered into the turn runs next,
  // as on Claude; without `resume` opencode would keep it until the next send.
  async function interrupt(): Promise<Outcome> {
    if (ended || session === null) return { ok: false, problem: "opencode is not connected" }
    out.push({ type: "interrupt", state: "asked", at: lastAt })
    const reply = await transport
      .request({ method: "POST", path: `/api/session/${session}/interrupt`, query: { resume: "true" } })
      .catch(() => null)
    const answer = reply ? answerOf(reply, interruptReply, "interrupt") : null
    const done = answer?.kind === "ok" && answer.value.interrupted
    out.push({ type: "interrupt", state: done ? "answered" : "refused", at: lastAt })
    if (done) return { ok: true, note: null }
    if (answer?.kind === "ok") return { ok: false, problem: "opencode was not running a turn" }
    return {
      ok: false,
      problem: answer?.kind === "error" && answer.message ? answer.message : "opencode did not interrupt the turn",
    }
  }

  // A shell is removed, a subagent's session interrupted.
  async function stop(id: string): Promise<Outcome> {
    if (ended || session === null) return { ok: false, problem: "opencode is not connected" }
    if (!translator.has(id)) return { ok: false, problem: "opencode does not know this task" }
    out.push(...translator.stopping(id, lastAt))
    const reply = await transport
      .request(
        translator.isShell(id)
          ? { method: "DELETE", path: `/api/shell/${id}` }
          : { method: "POST", path: `/api/session/${id}/interrupt` },
      )
      .catch(() => null)
    const answer = reply ? answerOf(reply, z.unknown(), "stop") : null
    if (answer?.kind === "ok") return { ok: true, note: null }
    translator.refused(id)
    const problem = answer?.kind === "error" && answer.message ? answer.message : "opencode did not stop the task"
    return { ok: false, problem }
  }

  async function replyTo(id: AskId, given: AskReply): Promise<void> {
    if (ended || own.answer(id, given)) return
    const known = translator.askOf(id)
    if (!known) return log.warn("opencode: an answer to an ask that is not open")
    if (known.form) return replyToForm(id, known.session, formReply(known.form, given))
    const body = permissionReply(given)
    if (!body) return log.warn(`opencode: a permission takes no ${given.type} reply`)
    translator.answering(id, body.message ?? "")
    const sent = await transport
      .request({ method: "POST", path: `/api/session/${known.session}/permission/${id}/reply`, body })
      .catch(() => null)
    const answer = sent ? answerOf(sent, z.unknown(), "permission reply") : null
    if (answer?.kind === "ok") return
    translator.answering(id, "")
    // Another client may have answered first; its reply closes the ask.
    log.warn(
      `opencode: the permission reply did not go through (${answer?.kind === "error" ? answer.tag || answer.status : "no answer"})`,
    )
  }

  // A dismissed form ends the turn, as opencode's own TUI does.
  async function replyToForm(id: AskId, of: string, reply: ReturnType<typeof formReply>): Promise<void> {
    const path = `/api/session/${of}/form/${id}`
    const sent = await transport
      .request(
        reply === "dismiss"
          ? { method: "DELETE", path }
          : { method: "POST", path: `${path}/reply`, body: { answer: reply.answer } },
      )
      .catch(() => null)
    const answer = sent ? answerOf(sent, z.unknown(), "form reply") : null
    if (answer?.kind === "ok") return
    // Another client may have answered first; its reply closes the ask.
    log.warn(
      `opencode: the form reply did not go through (${answer?.kind === "error" ? answer.tag || answer.status : "no answer"})`,
    )
  }

  async function removeRule(id: string): Promise<Outcome> {
    if (ended) return { ok: false, problem: "opencode is not connected" }
    const reply = await transport.request({ method: "DELETE", path: `/api/permission/saved/${id}` }).catch(() => null)
    const answer = reply ? answerOf(reply, z.unknown(), "saved permission") : null
    if (answer?.kind !== "ok")
      return {
        ok: false,
        problem: answer?.kind === "error" && answer.message ? answer.message : "opencode did not remove the rule",
      }
    rulesAsked = true
    await tellRules()
    return { ok: true, note: null }
  }

  function refresh(list: ListName): void {
    if (ended) return
    if (list === "modes") return void tellModes()
    if (list === "models") return void tellModels()
    if (list === "commands" || list === "skills" || list === "mcp" || list === "plugins") return tellList(list)
    if (list !== "rules") return
    rulesAsked = true
    void tellRules()
  }

  // opencode turns a server on or off in the running service, for every client of the folder, and writes no config.
  // Connecting a connected server starts it again. The list follows on opencode's word that the server changed.
  async function mcpRequest(name: string, action: "connect" | "disconnect", refused: string): Promise<Outcome> {
    if (ended) return { ok: false, problem: "opencode is not connected" }
    const reply = await transport
      .request({ method: "POST", path: `/api/experimental/mcp/${encodeURIComponent(name)}/${action}` })
      .catch(() => null)
    const answer = reply ? answerOf(reply, z.unknown(), "MCP server") : null
    if (answer?.kind === "ok") return { ok: true, note: null }
    return { ok: false, problem: answer?.kind === "error" && answer.message ? answer.message : refused }
  }

  // With the list, the model the session runs: its pick, else its mode's, else opencode's default.
  async function tellModels(): Promise<void> {
    const read = await readModels(transport)
    if (!read || ended || closed) return
    models = read
    out.push({ type: "lists", lists: { models: read }, at: lastAt })
    const fallback = await defaultRef(transport)
    if (!ended && !closed) out.push(...translator.listedModels(read, fallback, lastAt))
  }

  const listedModel = (choice: ModelRef) =>
    models
      ?.flatMap((group) => group.models)
      .find((row) => row.ref.id === choice.id && (choice.provider === null || row.ref.provider === choice.provider))

  // One switch at a time, each made from what the last one left; `make` gives the model, or why there is none.
  function pick(make: () => WireModel | string, refused: string): Promise<Outcome> {
    const done = picking.then(async (): Promise<Outcome> => {
      if (ended || session === null) return { ok: false, problem: "opencode is not connected" }
      const model = make()
      if (typeof model === "string") return { ok: false, problem: model }
      const reply = await transport
        .request({ method: "POST", path: `/api/session/${session}/model`, body: { model } })
        .catch(() => null)
      const answer = reply ? answerOf(reply, z.unknown(), "model switch") : null
      if (answer?.kind !== "ok")
        return { ok: false, problem: answer?.kind === "error" && answer.message ? answer.message : refused }
      // Told now, so a pick right after this one starts from it.
      out.push(...translator.chosen(model, lastAt))
      return { ok: true, note: null }
    })
    picking = done.catch(() => {})
    return done
  }

  // opencode takes any model and variant and fails the next turn on one it lacks, so only listed ones go out. The variant
  // goes with the model when the new one has it too.
  async function setModel(choice: ModelRef): Promise<Outcome> {
    if (ended || session === null) return { ok: false, problem: "opencode is not connected" }
    if (models === null) await tellModels()
    const row = listedModel(choice)
    const provider = row?.ref.provider
    if (!row || !provider) return { ok: false, problem: `opencode has no model ${choice.id}` }
    return pick(() => {
      const variant = translator.model()?.variant
      const keeps = variant !== undefined && row.efforts.some(({ id }) => id === variant)
      return { providerID: provider, id: row.ref.id, ...(keeps ? { variant } : {}) }
    }, "opencode did not switch the model")
  }

  // The default, or null, is no variant.
  async function setEffort(effort: EffortId | null): Promise<Outcome> {
    if (ended || session === null) return { ok: false, problem: "opencode is not connected" }
    if (models === null) await tellModels()
    return pick(() => {
      const now = translator.model()
      if (!now) return "opencode did not say which model the session runs"
      const row = listedModel({ provider: now.providerID, id: now.id })
      if (effort !== null && !row?.efforts.some(({ id }) => id === effort))
        return `opencode has no effort ${effort} for this model`
      const variant = effort === null || effort === DEFAULT_VARIANT ? {} : { variant: effort }
      return { providerID: now.providerID, id: now.id, ...variant }
    }, "opencode did not change the effort")
  }

  async function tellModes(): Promise<void> {
    const read = await readModes(transport)
    if (read && !ended && !closed) out.push(...translator.modes(read, null, lastAt))
  }

  // opencode tells the new title as session.renamed, like the ones it makes. A title it already has is not written again.
  async function rename(title: string): Promise<Outcome> {
    if (ended || session === null) return { ok: false, problem: "opencode is not connected" }
    if (translator.title() === title) return { ok: true, note: null }
    const reply = await transport
      .request({ method: "PATCH", path: `/api/session/${session}`, body: { title } })
      .catch(() => null)
    const answer = reply ? answerOf(reply, z.unknown(), "rename") : null
    if (answer?.kind === "ok") return { ok: true, note: null }
    const problem = answer?.kind === "error" && answer.message ? answer.message : "opencode did not rename the session"
    log.warn("opencode: rename failed", problem)
    return { ok: false, problem }
  }

  async function readSettings() {
    const rows = await settingRows(transport, options.cwd)
    if (!rows) throw new Error("opencode did not give its config")
    return rows
  }

  // True once opencode read the session's config again, false after `ms`.
  function configRead(ms: number): { read: Promise<boolean>; drop(): void } {
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const done = () => resolve(true)
    const timer = setTimeout(() => resolve(false), ms)
    const drop = () => {
      clearTimeout(timer)
      configWaiters.delete(done)
    }
    configWaiters.add(done)
    return { read: promise.finally(drop), drop }
  }

  // Resolves once opencode has the new value, so the next read shows it.
  async function writeSettingNow(id: string, value: SettingValue): Promise<Outcome> {
    if (ended) return { ok: false, problem: "opencode is not connected" }
    const wait = configRead(CONFIG_MS)
    const done = await writeSetting(transport, id, value)
    if (!done.ok) {
      wait.drop()
      return done
    }
    if (!(await wait.read)) log.warn("opencode: no word that the config was read again")
    return done
  }

  // Ctrl+B: opencode moves the calls that block the turn to the background.
  async function background(): Promise<Outcome> {
    if (ended || session === null) return { ok: false, problem: "opencode is not connected" }
    const reply = await transport
      .request({ method: "POST", path: `/api/session/${session}/background` })
      .catch(() => null)
    const answer = reply ? answerOf(reply, z.unknown(), "background") : null
    if (answer?.kind === "ok") return { ok: true, note: null }
    const problem =
      answer?.kind === "error" && answer.message ? answer.message : "opencode did not send it to the background"
    return { ok: false, problem }
  }

  // Before the first step, the session runs opencode's default model.
  async function context() {
    const known = translator.context()
    if (known) return contextReport(known.model, known.used, known.window)
    const fallback = await defaultModel(transport)
    if (!fallback) throw new Error("opencode did not say which model the session runs")
    return contextReport(fallback.model, 0, fallback.window)
  }

  async function restart(): Promise<Outcome> {
    if (!ended || closed) return { ok: false, problem: "opencode is still connected" }
    if (deleted !== null) return { ok: false, problem: deleted }
    out.push({ type: "starting", at: lastAt })
    try {
      transport = deps.transport(await deps.service(binary), options.cwd)
      stream = new AbortController()
      ended = false
      await open(true)
      return { ok: true, note: null }
    } catch (error) {
      stream.abort()
      ended = true
      const problem = error instanceof Error ? error.message : "opencode did not start"
      out.push({ type: "ended", problem: { text: problem, detail: [] }, at: lastAt })
      return { ok: false, problem }
    }
  }

  const agent: OpencodeAgent = {
    kind: OPENCODE,
    session: ref,
    version: found.version,
    caps: OPENCODE_CAPS,
    events: out,
    send,
    interrupt,
    answer: replyTo,
    restart,
    async close() {
      if (closed) return
      closed = true
      stream.abort()
      own.close()
      out.push({ type: "ended", problem: null, at: lastAt })
      out.end()
      if (ended || session === null) return
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, LEAVE_MS)))
      await Promise.race([allowQuestions(transport, session), late]).finally(() => clearTimeout(timer))
    },
    setMode,
    setModel,
    setEffort,
    setExtraEffort: later("extra effort"),
    setThinking: later("thinking"),
    rename,
    cut,
    undoCut,
    refresh,
    tasks: { stop, background },
    mcp: {
      toggle: (name, on) =>
        mcpRequest(
          name,
          on ? "connect" : "disconnect",
          on ? "opencode did not turn the server on" : "opencode did not turn the server off",
        ),
      reconnect: (name) => mcpRequest(name, "connect", "opencode did not reconnect the server"),
      login: later("MCP login"),
    },
    skills: { toggle: later("skills"), reload: later("skills") },
    plugins: { toggle: later("plugins"), reload: later("plugins") },
    permissions: { remove: removeRule },
    settings: { rows: readSettings, write: writeSettingNow },
    context,
    usage: () => Promise.reject(new Error("opencode usage is not built yet")),
    files: (query) => findFiles(transport, query),
    setClientTools(tools) {
      if (closed) return Promise.resolve({ ok: false, problem: "opencode was closed" })
      own.setTools(tools)
      return Promise.resolve({ ok: true, note: null })
    },
    setMcpServers: later("MCP servers"),
    goBack,
    connected(count) {
      const done = Promise.withResolvers<void>()
      waiters.push({ count, resolve: done.resolve })
      settle()
      return done.promise
    },
  }
  return agent
}

export function startOpencode(options: StartOptions, deps: Partial<Deps> = {}): Promise<OpencodeAgent> {
  return connect(options, { ...realDeps, ...deps })
}

export function opencodeKind(deps: Partial<Deps> = {}): Omit<AgentKind, "start"> & {
  start(options: StartOptions): Promise<OpencodeAgent>
} {
  const merged = { ...realDeps, ...deps }
  let checked: ReturnType<typeof usable> | null = null
  // The lists share one look for the service while it runs, and a failed one holds until the next detection or start,
  // so each list does not start the service again.
  let finding: Promise<Endpoint> | null = null
  let failed: Error | null = null
  function endpoint(binary: string): Promise<Endpoint> {
    if (failed !== null) return Promise.reject(failed)
    finding ??= merged
      .service(binary)
      .catch((error: unknown) => {
        failed = error instanceof Error ? error : new Error(String(error))
        throw failed
      })
      .finally(() => (finding = null))
    return finding
  }
  // The lists read the shared service, and start it as `start` would. The agent is checked once per kind.
  async function service(cwd: string): Promise<Transport> {
    checked ??= usable(merged)
    const { binary } = await checked.catch((error: unknown) => {
      checked = null
      throw error
    })
    return merged.transport(await endpoint(binary), cwd)
  }
  return {
    id: OPENCODE,
    name: OPENCODE_NAME,
    caps: OPENCODE_CAPS,
    detect: () => {
      failed = null
      return merged.detect()
    },
    start: (options) => {
      failed = null
      return connect(options, merged)
    },
    sessions: async (cwd) => listSessions(await service(cwd), cwd),
    // Any folder will do for reading a session by its id.
    history: async (ref, cursor) => historyPage(await service(process.cwd()), ref.id, cursor),
    oneShot: (prompt, cwd) =>
      service(cwd).then(
        (transport) => answerOnce(transport, prompt),
        (error: unknown) => {
          log.warn("opencode: session title failed", error instanceof Error ? error.message : String(error))
          return null
        },
      ),
  }
}
