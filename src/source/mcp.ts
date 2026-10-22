import { statSync } from "node:fs"
import { basename } from "node:path"
import { z } from "zod"
import { log } from "../log/log.ts"
import { rowsOf } from "../protocol/json.ts"
import { isOwnAskServer, mcpServerRows, mcpServerStatus, type ProtocolMessage } from "../protocol/messages.ts"
import { mcpReconnectRequest, mcpStatusRequest, mcpToggleRequest } from "../protocol/outgoing.ts"
import type { SessionStore } from "../session/session.ts"
import type { McpConfig, McpServer } from "../session/types.ts"
import { printable } from "../ui/format.ts"
import type { McpActions } from "../ui/mcp/mcp-tab.tsx"
import { shortName } from "../ui/mcp/servers.ts"
import { type Requests, RequestTimeout } from "./requests.ts"

// Live only: the server list from mcp_status, which init does not have before the first message, nor errors, tools
// or configs at all, and the actions of the MCP tab.
export type McpControls = {
  initialized(reply: unknown): void
  onMessage(message: ProtocolMessage): void
  refresh(): void
  actions: McpActions
  // Its claude is being replaced: no more asking.
  dispose(): void
}

// claude pushes nothing when a server is done connecting, so a list with pending servers is asked for again.
const PENDING_EVERY_MS = 2000
const PENDING_POLLS = 15
const CHANGE_TIMEOUT_MS = 60_000

const stdioConfig = z.looseObject({ command: z.string(), args: z.array(z.unknown()).optional() })
const remoteConfig = z.looseObject({ url: z.string() })

// Flags that take no value, so the package still comes right after them.
const BARE_FLAGS = new Set(["-y", "--yes", "-q", "--quiet"])
const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i

// The package a runner such as npx starts, when it comes first. Anything later (or after a flag that takes a value)
// can be a key, so it is never kept.
function packageOf(command: string, args: unknown[]): string | null {
  const runner = command.split("/").at(-1)
  const rest =
    runner === "npx" || runner === "bunx" || runner === "uvx"
      ? args
      : runner === "pnpm" && args[0] === "dlx"
        ? args.slice(1)
        : null
  const first = rest?.find((arg) => typeof arg !== "string" || !BARE_FLAGS.has(arg))
  return typeof first === "string" && PACKAGE_NAME.test(first) ? first : null
}

// A url's path, query, hash and user part can all hold a key (hosted servers put one in the path).
const safeUrl = (url: URL) => (url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin)

const ASSIGNMENT = /^[A-Za-z_]\w*=/

const isFile = (path: string) => {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
  } catch {
    return false
  }
}

// A command string can carry variables and arguments ("KEY=… npx -y server --token …"), so only the program shows:
// the whole string when it names a file (a path with a space), else its first word that sets no variable.
function programOf(command: string): string {
  const whole = command.trim()
  if (/\s/.test(whole) && isFile(whole)) return basename(whole)
  return whole.split(/\s+/).find((word) => !ASSIGNMENT.test(word)) ?? ""
}

// claude's text about a server can quote its url, its command string, or what the server itself sent.
function safeText(text: string, command?: string): string {
  let shown = text
  const program = command === undefined ? "" : programOf(command)
  for (const form of new Set([command, command?.trim()]))
    if (form && form !== program) shown = shown.replaceAll(form, program)
  return printable(shown).replace(/[a-z][\w+.-]*:\/\/[^\s"'<>]+/gi, (found) => {
    // claude quotes some urls already cut, such as http://host:9[redacted]?key=REDACTED or http://host:9[redacted].
    const bare = found.replace(/\[redacted\]$/i, "")
    const tail = /[).,;:\]]*$/.exec(bare)?.[0] ?? ""
    const url = URL.parse(bare.slice(0, bare.length - tail.length))
    if (url) return `${safeUrl(url)}${tail}`
    const start = /^([a-z][\w+.-]*:\/\/)([^/?#[\s]*)/i.exec(bare)
    return start ? `${start[1]}${start[2]?.split("@").at(-1) ?? ""}${tail}` : "<url>"
  })
}

const commandOf = (config: unknown) => stdioConfig.safeParse(config).data?.command

// Only what is safe to show: env, headers and other arguments can hold credentials too.
function configOf(config: unknown): McpConfig | null {
  const stdio = stdioConfig.safeParse(config)
  if (stdio.success) {
    const command = programOf(stdio.data.command)
    return { command: printable(command), package: packageOf(command, stdio.data.args ?? []) }
  }
  const remote = remoteConfig.safeParse(config)
  const url = remote.success ? URL.parse(remote.data.url) : null
  return url ? { url: safeUrl(url) } : null
}

// Row by row, so one odd server does not empty the list.
export function mcpServers(rows: unknown[]): McpServer[] {
  const parsed = rowsOf(mcpServerStatus, rows)
  const servers = parsed.rows.flatMap((row): McpServer[] => {
    if (isOwnAskServer(row)) return []
    const { name, status, error, scope, source, serverInfo, config, tools } = row
    return [
      {
        name,
        status,
        source: source ?? null,
        scope: scope ?? null,
        error: error ? safeText(error, commandOf(config)) : null,
        config: configOf(config),
        serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : null,
        tools: tools ? tools.map((tool) => printable(tool.name)) : null,
      },
    ]
  })
  if (parsed.dropped > 0) log.warn(`mcp status: dropped ${parsed.dropped} of ${rows.length} rows`)
  return servers
}

const failureText = (error: unknown, command?: string) =>
  error instanceof RequestTimeout
    ? "Claude Code did not answer"
    : safeText(error instanceof Error ? error.message : String(error), command)

const commandRow = z.looseObject({ name: z.string(), config: stdioConfig })

const count = (servers: McpServer[], status: string) => servers.filter((server) => server.status === status).length

export function createMcpControls(options: { requests: Requests; session: SessionStore }): McpControls {
  const { requests, session } = options
  let asking = false
  let again = false
  let polls = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  // Servers with a reconnect or toggle under way: the state they show until it settles, and what is under way.
  const changing = new Map<string, { status: string; doing: string }>()
  // Each server's command string as configured, to keep it out of claude's error texts.
  const commands = new Map<string, string>()

  const known = () => session.state.mcpServers ?? session.state.info?.mcpServers ?? []
  const shown = (servers: McpServer[]) =>
    servers.map((server) => {
      const status = changing.get(server.name)?.status
      return status === undefined ? server : { ...server, status, error: null }
    })

  const ask = () => {
    clearTimeout(timer)
    if (disposed || session.state.status === "ended") return
    if (asking) {
      again = true
      return
    }
    asking = true
    requests
      .send(mcpStatusRequest)
      .then(
        (reply) => {
          const rows = mcpServerRows.safeParse(reply).data?.mcpServers
          if (!rows) return log.warn("mcp status: no server list in the reply")
          for (const row of rows) {
            const found = commandRow.safeParse(row)
            if (found.success) commands.set(found.data.name, found.data.config.command)
          }
          const servers = mcpServers(rows)
          session.setLists({ mcpServers: shown(servers) })
          log.info("mcp status", {
            servers: servers.length,
            failed: count(servers, "failed"),
            pending: count(servers, "pending"),
          })
        },
        (error: unknown) => log.warn("mcp status failed", failureText(error)),
      )
      .finally(() => {
        asking = false
        if (again) {
          again = false
          ask()
        } else if (polls > 0 && known().some((server) => server.status === "pending")) {
          polls -= 1
          timer = setTimeout(ask, PENDING_EVERY_MS)
        }
      })
  }

  const refresh = () => {
    polls = PENDING_POLLS
    ask()
  }

  // The row shows its new state at once; the list claude reports afterwards says how it went.
  const change = (name: string, status: string, doing: string, build: (requestId: string) => string) => {
    if (session.state.status === "ended") return Promise.reject(new Error("Claude Code exited"))
    const running = changing.get(name)
    if (running) return Promise.reject(new Error(`${shortName(name)} is still ${running.doing}`))
    const before = known().find((server) => server.name === name)
    const previous = before ? { ...before } : null
    changing.set(name, { status, doing })
    session.setLists({ mcpServers: shown(known()) })
    return requests.send(build, CHANGE_TIMEOUT_MS).then(
      () => {
        changing.delete(name)
        refresh()
      },
      (error: unknown) => {
        changing.delete(name)
        // Until claude's list says otherwise (and if it never comes), the row is as it was.
        if (previous)
          session.setLists({ mcpServers: known().map((server) => (server.name === name ? previous : server)) })
        refresh()
        throw new Error(failureText(error, commands.get(name)))
      },
    )
  }

  return {
    initialized: () => refresh(),
    // init carries only names and states, so a list that still matches them keeps its details.
    onMessage(message) {
      if (message.type !== "system" || message.subtype !== "init") return
      const servers = session.state.mcpServers
      const rows = message.mcp_servers.filter((row) => !isOwnAskServer(row))
      const same =
        servers !== null &&
        servers.length === rows.length &&
        rows.every((row) => servers.some((server) => server.name === row.name && server.status === row.status))
      if (!same) refresh()
    },
    refresh,
    dispose() {
      disposed = true
      clearTimeout(timer)
    },
    actions: {
      reconnect(name) {
        log.info("mcp reconnect", { name })
        return change(name, "pending", "reconnecting", (id) => mcpReconnectRequest(id, name))
      },
      setEnabled(name, enabled) {
        log.info(`mcp turn ${enabled ? "on" : "off"}`, { name })
        return change(name, enabled ? "pending" : "disabled", enabled ? "turning on" : "turning off", (id) =>
          mcpToggleRequest(id, name, enabled),
        )
      },
      // There is no sign-in over this connection; a reconnect picks up one done elsewhere.
      login(name) {
        log.info("mcp login", { name })
        const server = known().find((entry) => entry.name === name)
        const connector = (server?.source ?? server?.scope) === "claudeai"
        return change(name, "pending", "reconnecting", (id) => mcpReconnectRequest(id, name)).catch(
          (error: unknown) => {
            // claude answers "Server status: needs-auth".
            if (!failureText(error).includes("needs-auth")) throw error
            throw new Error(
              connector
                ? `Connect ${shortName(name)} on claude.ai, then press Log in again`
                : "Log in with /mcp in Claude Code, then press Log in again",
            )
          },
        )
      },
    },
  }
}
