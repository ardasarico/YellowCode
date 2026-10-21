import type { LiveProvider } from "../input/provider.ts"
import { log } from "../log/log.ts"
import { commandRows, modelRows } from "../protocol/messages.ts"
import { initializeRequest } from "../protocol/outgoing.ts"
import { parse } from "../protocol/parse.ts"
import { ownAskRejection } from "../session/ask.ts"
import type { SessionStore } from "../session/session.ts"
import type { StoredSettings } from "../session/settings-file.ts"
import { type ClaudeSource, createClaudeSource, describeExit } from "./claude.ts"
import { claudeArgs, type Spawn } from "./claude-args.ts"
import { type Controls, createControls, type Knobs } from "./controls.ts"
import { createExtensions, type Extensions } from "./extensions.ts"
import { createMcpControls, type McpControls } from "./mcp.ts"
import { createRequests, refusal, type Requests, RequestTimeout } from "./requests.ts"
import type { Source } from "./source.ts"
import { createTaskControls, type TaskControls } from "./tasks.ts"

const INVALID_LOG_EVERY = 100
const EXIT_WAIT_MS = 3000
const INITIALIZE_TIMEOUT_MS = 60_000
// A closed claude ends within its own idle grace and kill timers; this only bounds a process that will not die.
const CLOSE_WAIT_MS = 8000

export type Connection = {
  session: SessionStore
  source: ClaudeSource
  requests: Requests
  controls: Controls
  mcp: McpControls
  extensions: Extensions
  tasks: TaskControls
  spawn: Spawn
  // Sends initialize and reads claude's lines into the session; called once, when the app is ready for them.
  start(): void
  // Stops claude and leaves the session as it is (another session opens, the app quits); resolves once the claude
  // process has ended, or after CLOSE_WAIT_MS.
  close(): Promise<void>
}

const invalidCounts = new Map<string, number>()

// Feeds a source's lines to the session. Live, claude's own requests that nothing here handles get an error reply.
export async function pump(
  source: Source,
  session: SessionStore,
  live: { requests: Requests; controls: Controls } | null,
): Promise<void> {
  let yielded = performance.now()
  try {
    for await (const event of source.events) {
      const parsed = parse(event.line)
      if (parsed.kind === "invalid") {
        const count = (invalidCounts.get(parsed.key) ?? 0) + 1
        invalidCounts.set(parsed.key, count)
        if (count === 1) log.warn(`invalid ${parsed.key} message: ${parsed.error}`, parsed.raw)
        else if (count % INVALID_LOG_EVERY === 0) log.warn(`invalid ${parsed.key} messages: ${count} so far`)
      }
      if (parsed.kind === "unknown" && event.dir === "in") log.debug(`unknown message ${parsed.key}`)
      session.apply(event.dir, parsed, event.at)
      if (event.dir === "in" && parsed.kind === "message") live?.controls.onMessage(parsed.message)
      if (event.dir === "in" && parsed.kind === "message" && parsed.message.type === "control_response")
        live?.requests.settle(parsed.message.response)
      if (live && event.dir === "in" && parsed.kind !== "message" && parsed.key.startsWith("control_request/")) {
        const subtype = parsed.key.slice("control_request/".length)
        const reply = refusal(
          event.line,
          parsed.kind === "unknown"
            ? `YellowCode does not support ${subtype}`
            : `YellowCode could not read this ${subtype} request`,
        )
        if (reply) {
          log.warn(`answered ${parsed.key} with an error`)
          source.send(reply)
        }
      }
      const rejection = event.dir === "in" && parsed.kind === "message" ? ownAskRejection(parsed.message) : null
      if (rejection) {
        log.info("rejected own ask", rejection)
        session.answer(rejection)
        source.send(rejection)
      }
      // Lines that are already waiting arrive without a macrotask, so a burst would not paint until it ends.
      if (performance.now() - yielded > 8) {
        await new Promise((resolve) => setImmediate(resolve))
        yielded = performance.now()
      }
    }
  } catch (error) {
    log.error("source failed", error)
  }
}

// Spawns claude for the session. Only an exit nobody asked for ends the session.
export function connect(options: {
  cwd: string
  session: SessionStore
  spawn: Spawn
  stored: Pick<StoredSettings, "thinking" | "permissionMode">
  provider: LiveProvider
  // The knobs of a conversation claude runs again, sent before anything else.
  carry?: Knobs
}): Connection {
  const { cwd, session, spawn, stored, provider, carry } = options
  // claude ends on closed input only once its turn and its background tasks are done.
  const busy = () =>
    session.state.status === "running" || Object.values(session.state.tasks).some((task) => task.state === "running")
  const source = createClaudeSource(cwd, busy, ["claude", ...claudeArgs(stored, spawn)])
  const requests = createRequests((line) => source.send(line))
  const bypass = stored.permissionMode === "bypassPermissions"
  const controls = createControls({ requests, provider, session, bypass })
  const mcp = createMcpControls({ requests, session })
  controls.follow(mcp)
  const extensions = createExtensions({ requests, provider, session, cwd })
  controls.follow(extensions)
  const tasks = createTaskControls({ requests, session })
  log.info("claude flags", { permissionMode: stored.permissionMode, thinking: stored.thinking, bypass, ...spawn })

  // What claude offers before the first message (system/init only comes with it). The reply also names the account,
  // so only counts are logged.
  const initialized = Promise.withResolvers<unknown>()
  // A claude that stays silent through initialize is closed, and its end says why.
  let silent = false
  let closing = false

  // Nothing of this claude's asks or polls once it is closed or gone; the pump may still apply its last lines.
  const stopWork = () => {
    tasks.close()
    mcp.dispose()
    extensions.dispose()
  }

  function initialize(): void {
    const started = performance.now()
    // With perTaskStopAffordance an interrupt leaves background agents running; x stops one task at a time.
    void requests
      .send((id) => initializeRequest(id, { perTaskStopAffordance: true }), INITIALIZE_TIMEOUT_MS)
      .then(
        (reply) => {
          log.info("initialized", {
            commands: commandRows.safeParse(reply).data?.commands.length ?? 0,
            models: modelRows.safeParse(reply).data?.models.length ?? 0,
            ms: Math.round(performance.now() - started),
          })
          initialized.resolve(reply)
        },
        (error: unknown) => {
          log.warn("initialize failed", error instanceof Error ? error.message : error)
          initialized.resolve(null)
          if (!(error instanceof RequestTimeout)) return
          silent = true
          source.close()
        },
      )
  }

  async function run(): Promise<void> {
    initialize()
    void initialized.promise.then((reply) => {
      if (reply) controls.initialized(reply)
    })
    if (carry) controls.carry(carry)
    tasks.start()
    await pump(source, session, { requests, controls })
    stopWork()
    requests.close("Claude Code exited")
    // A process claude started can keep its stderr open after claude itself has gone.
    const exit = await Promise.race([source.exited, Bun.sleep(EXIT_WAIT_MS).then(() => source.exitNow())])
    if (closing) return
    if (silent)
      session.end({ text: `Claude Code did not answer in ${INITIALIZE_TIMEOUT_MS / 1000} s`, detail: exit.stderr })
    else if (exit.closed) session.end()
    else if (exit.code === null && exit.signal === null) {
      log.warn("claude closed its output but still runs")
      source.close()
      session.end({ text: "Claude Code stopped responding", detail: exit.stderr })
    } else session.end(describeExit(exit))
  }

  return {
    session,
    source,
    requests,
    controls,
    mcp,
    extensions,
    tasks,
    spawn,
    start() {
      void run()
    },
    async close() {
      closing = true
      controls.dispose()
      stopWork()
      source.close()
      await Promise.race([source.ended, Bun.sleep(CLOSE_WAIT_MS)])
    },
  }
}
