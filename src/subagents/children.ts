import type { Agent, AgentKind, Prompt, StartOptions } from "../agent/agent.ts"
import type { AgentEvent } from "../agent/events.ts"
import type { AgentKindId, ModelRef, Outcome } from "../agent/ids.ts"
import type { ModeKind, ModeRow } from "../agent/lists.ts"
import { follow, showEarly } from "../session/follow.ts"
import { createSession, type SessionStore } from "../session/session.ts"
import type { Definition } from "./definitions.ts"
import { childMode } from "./mode.ts"

export type ChildState = "queued" | "running" | "idle" | "failed" | "stopped" | "closed"

// A provider as a child starts on it. claude feeds the store it is given; the others' events are followed into it.
export type Launcher = Pick<AgentKind, "id" | "name" | "caps"> & {
  start(options: StartOptions, store: SessionStore): Promise<Agent>
  // The prompt in the child's chat as it goes out; showEarly when not given.
  show?(store: SessionStore, prompt: Prompt): void
  // It answers an ask from the ask in its own store, so its asks stay there too.
  keepsAsks?: boolean
}

export type Child = {
  id: string
  // The agent definition's name, or "bare".
  name: string
  provider: AgentKindId
  model: ModelRef
  task: string
  state: ChildState
  startedAt: number | null
  // When its last turn ended, or when it failed, stopped or closed.
  endedAt: number | null
  problem: string | null
  store: SessionStore
  agent: Agent | null
}

// At each turn end. `files`: what the child's edit and write calls changed; a shell command's changes are missed.
export type ChildResult = { text: string; files: string[]; durationMs: number; error: string | null }

export type SpawnRequest = {
  launcher: Launcher
  // null: a bare child, with no definition.
  definition: Pick<Definition, "name" | "permissions" | "plugins" | "instructions"> | null
  model: ModelRef
  task: string
  prompt: string
  cwd: string
  parentMode: ModeKind
  // The provider's modes, to pick the child's from.
  modes: ModeRow[]
  // Called when the user is asked first, so the caller need not wait for the answer.
  asking?(): void
}

export type ChildrenOptions = {
  // How many children may run at once.
  limit(): number
  // The user's yes for a child whose narrowest mode is wider than allowed.
  confirm(text: string, task: string): Promise<boolean>
  onResult(child: Child, result: ChildResult): void
  onChange?(child: Child): void
  // True when the event stays out of the child's store, as its asks do.
  take?(child: Child, event: AgentEvent, launcher: Launcher): boolean
  close?(agent: Agent): Promise<void>
  now?(): number
}

type Run = {
  launcher: Launcher
  options: StartOptions
  // The prompt waiting for a free slot.
  pending: string | null
  // The instructions, for a provider that takes none at start.
  preface: string | null
  // Where the turn's items begin in the store.
  mark: number
  turnStart: number
}

type Entry = { child: Child; run: Run }

const EDITS = new Set(["edit", "write"])

function lastText(store: SessionStore, from: number): string {
  const { items, byId } = store.state
  for (let index = items.length - 1; index >= from; index--) {
    const item = byId[items[index] ?? ""]
    if (item?.kind === "text" && !item.quiet && !item.local) return item.markdown
  }
  return ""
}

function changedFiles(store: SessionStore, from: number): string[] {
  const { items, byId } = store.state
  const paths = new Set<string>()
  for (const id of items.slice(from)) {
    const item = byId[id]
    if (item?.kind !== "tool" || !EDITS.has(item.toolKind) || item.status !== "done") continue
    if (item.files.length > 0) for (const file of item.files) paths.add(file.path)
    else if (item.summary) paths.add(item.summary)
  }
  return [...paths]
}

function confirmText(launcher: Launcher, name: string, mode: ModeRow): string {
  const how = mode.kind === "bypass" ? "without approvals" : `in ${mode.label}, wider than this session allows`
  return `${launcher.name} runs ${name} ${how}. Run it anyway?`
}

export function createChildren(options: ChildrenOptions) {
  const now = () => (options.now ? options.now() : Date.now())
  const closeAgent = (agent: Agent) => (options.close ? options.close(agent) : agent.close())
  const entries: Entry[] = []
  let count = 0

  const changed = (child: Child) => options.onChange?.(child)
  const entryOf = (id: string) => entries.find((entry) => entry.child.id === id)

  function pump(): void {
    for (const entry of entries) {
      if (entries.filter(({ child }) => child.state === "running").length >= options.limit()) return
      if (entry.child.state === "queued") void begin(entry)
    }
  }

  async function begin({ child, run }: Entry): Promise<void> {
    child.state = "running"
    child.startedAt ??= now()
    child.endedAt = null
    changed(child)
    if (!child.agent) {
      let agent: Agent
      try {
        agent = await run.launcher.start(run.options, child.store)
      } catch (error) {
        fail(
          { child, run },
          `${run.launcher.name} did not start: ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
      child.agent = agent
      // Stopped or closed while it started.
      if (child.state !== "running") {
        await closeAgent(agent)
        return
      }
      void follow(agent.events, child.store, run.launcher.name)
    }
    const text = run.pending ?? ""
    run.pending = null
    const prompt: Prompt = {
      id: crypto.randomUUID(),
      text: run.preface ? `${run.preface}\n\n${text}` : text,
      images: [],
      command: null,
      to: null,
      delivery: "queue",
      kept: [],
      shells: [],
    }
    run.preface = null
    run.mark = child.store.state.items.length
    run.turnStart = now()
    if (run.launcher.show) run.launcher.show(child.store, prompt)
    else showEarly(child.store, prompt)
    const sent = await child.agent.send(prompt)
    if (!sent.ok) fail({ child, run }, sent.problem)
  }

  function finish({ child, run }: Entry, error: string | null): void {
    child.state = "idle"
    child.endedAt = now()
    changed(child)
    options.onResult(child, {
      text: lastText(child.store, run.mark),
      files: changedFiles(child.store, run.mark),
      durationMs: child.endedAt - run.turnStart,
      error,
    })
    pump()
  }

  function fail({ child, run }: Entry, problem: string): void {
    if (child.state === "failed" || child.state === "stopped" || child.state === "closed") return
    const wasRunning = child.state === "running"
    child.state = "failed"
    child.problem = problem
    child.endedAt = now()
    if (child.agent) void closeAgent(child.agent)
    changed(child)
    if (wasRunning)
      options.onResult(child, {
        text: lastText(child.store, run.mark),
        files: changedFiles(child.store, run.mark),
        durationMs: child.endedAt - run.turnStart,
        error: problem,
      })
    pump()
  }

  function seen(entry: Entry, event: AgentEvent): void {
    const { state } = entry.child
    if (event.type === "turn.end" && !event.local && state === "running") finish(entry, event.error)
    else if (event.type === "ended" && state !== "closed" && state !== "stopped")
      fail(entry, event.problem?.text ?? `${entry.run.launcher.name} stopped`)
    // A child keeps nothing to go on with, so one whose provider starts again is gone.
    else if (event.type === "starting") fail(entry, `${entry.run.launcher.name} restarted`)
  }

  async function spawn(request: SpawnRequest): Promise<{ ok: true; child: Child } | { ok: false; problem: string }> {
    const { launcher, definition } = request
    const name = definition?.name ?? "bare"
    const shown = definition?.name ?? request.model.id
    const fit = childMode(request.parentMode, definition?.permissions ?? "inherit", request.modes)
    if (fit.fit === "none") return { ok: false, problem: `${launcher.name} has no mode to run ${shown} in` }
    if (fit.fit === "confirm") request.asking?.()
    if (fit.fit === "confirm" && !(await options.confirm(confirmText(launcher, shown, fit.mode), request.task)))
      return { ok: false, problem: `the user did not let ${shown} run on ${launcher.name}` }
    const instructions = definition?.instructions ?? ""
    const own = launcher.caps.instructions
    const id = `c${++count}`
    const store = createSession({ idPrefix: `${id}-`, starting: true })
    const child: Child = {
      id,
      name,
      provider: launcher.id,
      model: request.model,
      task: request.task,
      state: "queued",
      startedAt: null,
      endedAt: null,
      problem: null,
      store: {
        ...store,
        event(event) {
          if (!options.take?.(child, event, launcher)) store.event(event)
          seen(entry, event)
        },
      },
      agent: null,
    }
    const run: Run = {
      launcher,
      options: {
        cwd: request.cwd,
        resume: null,
        mode: fit.mode.id,
        defaultMode: null,
        model: request.model,
        effort: null,
        extraEffort: false,
        thinking: true,
        instructions: own && instructions ? [instructions] : [],
        clientTools: [],
        mcpServers: [],
        ephemeral: true,
        plain: !(definition?.plugins ?? false),
      },
      pending: request.prompt,
      preface: !own && instructions ? instructions : null,
      mark: 0,
      turnStart: 0,
    }
    const entry = { child, run }
    entries.push(entry)
    changed(child)
    pump()
    return { ok: true, child }
  }

  function send(id: string, text: string): Outcome {
    const entry = entryOf(id)
    if (!entry) return { ok: false, problem: `no subagent ${id}` }
    const { child, run } = entry
    if (child.state !== "idle") return { ok: false, problem: `${child.name} is ${child.state}` }
    run.pending = text
    child.state = "queued"
    changed(child)
    pump()
    return { ok: true, note: null }
  }

  // A running child is interrupted and stays open; a queued one is dropped.
  async function stop(id: string): Promise<Outcome> {
    const entry = entryOf(id)
    if (!entry) return { ok: false, problem: `no subagent ${id}` }
    const { child, run } = entry
    if (child.state === "running" && child.agent) return child.agent.interrupt()
    if (child.state === "queued" && child.agent) {
      run.pending = null
      child.state = "idle"
    } else if (child.state === "queued" || child.state === "running") {
      child.state = "stopped"
      child.endedAt = now()
    } else return { ok: false, problem: `${child.name} is ${child.state}` }
    changed(child)
    pump()
    return { ok: true, note: null }
  }

  async function close(id: string): Promise<void> {
    const child = entryOf(id)?.child
    if (!child || child.state === "closed") return
    child.state = "closed"
    child.endedAt = now()
    changed(child)
    pump()
    if (child.agent) await closeAgent(child.agent)
  }

  return {
    spawn,
    send,
    stop,
    close,
    // For a parent session that is replaced, cleared or quit.
    closeAll: () => Promise.all(entries.map(({ child }) => close(child.id))).then(() => {}),
    list: (): Child[] => entries.map(({ child }) => child),
    get: (id: string) => entryOf(id)?.child,
  }
}

export type Children = ReturnType<typeof createChildren>
