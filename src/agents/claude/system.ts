import type { LimitWindow, SessionInfo } from "../../agent/events.ts"
import type { McpServerRow } from "../../agent/lists.ts"
import { log } from "../../log/log.ts"
import { isOwnAskServer, type ProtocolMessage } from "../../protocol/messages.ts"
import { type Draft, textOf } from "./draft.ts"
import { LOGIN_HINT, needsLogin } from "./login.ts"
import { placeOf, shortName, stateOf, toolServer } from "./mcp-rows.ts"
import { mcpOf } from "./tools.ts"

type Of<T extends ProtocolMessage["type"]> = Extract<ProtocolMessage, { type: T }>
type System<S extends Of<"system">["subtype"]> = Extract<Of<"system">, { subtype: S }>

const FIVE_HOURS = 5 * 60
const WEEK = 7 * 24 * 60

const minutesOf = (type: string | undefined) =>
  type === "five_hour" ? FIVE_HOURS : type?.startsWith("seven_day") ? WEEK : null

// Claude gives resets in seconds.
const seconds = (window: { utilization: number; resetsAt: number }) => ({
  utilization: window.utilization,
  resetsAt: window.resetsAt * 1000,
})

// Our own ask server is YellowCode's business, not a server of the user's.
export function initInfo(message: System<"init">): SessionInfo {
  return {
    id: message.session_id,
    model: { provider: null, id: message.model },
    mode: message.permissionMode,
    cwd: message.cwd,
    version: message.claude_code_version,
    tools: message.tools.map((name) => ({ name, mcp: mcpOf(name) })),
    mcpServers: message.mcp_servers
      .filter((server) => !isOwnAskServer(server))
      .map((server): McpServerRow => ({
        name: server.name,
        label: shortName(server.name),
        place: placeOf(server.source ?? null),
        state: stateOf(server.status),
        status: server.status,
        // claude's own word, which the store keeps as the server's source; the rows it shows come from mcpRows.
        origin: server.source ?? null,
        scope: null,
        error: server.error ?? null,
        config: null,
        server: null,
        tools: null,
        toolServer: toolServer(server.name),
      })),
    skills: message.skills,
    commands: message.slash_commands ?? [],
    subagents: message.agents ?? [],
    plugins: (message.plugins ?? []).map(({ name, path, source }) => ({ name, path, source: source ?? null })),
    // A subscription sign-in is no key: the UI shows no cost for it.
    authSource: !message.apiKeySource || message.apiKeySource === "oauth" ? "none" : message.apiKeySource,
  }
}

// A mode change reports itself as a status too, and says nothing about a compaction going on.
function statusOf(message: System<"status">): Draft[] {
  const prompts = message.user_message_uuids ?? []
  const requesting = message.status === "requesting"
  const out: Draft[] = []
  if (!requesting && prompts.length > 0) out.push({ type: "user.taken", prompts })
  if (message.permissionMode) out.push({ type: "mode", mode: message.permissionMode })
  if (message.status === "compacting") out.push({ type: "compaction", running: true })
  else if (!message.permissionMode) out.push({ type: "compaction", running: false })
  if (requesting) out.push({ type: "turn.step", prompts })
  return out
}

export function limitsOf(message: Of<"rate_limit_event">): Draft[] {
  const info = message.rate_limit_info
  const family = info.rateLimitType?.match(/^seven_day_(opus|sonnet)$/)?.[1] ?? null
  const windows: LimitWindow[] = []
  const { five_hour: fiveHour, seven_day: week } = info.unifiedWindows ?? {}
  if (fiveHour) windows.push({ minutes: FIVE_HOURS, model: null, ...seconds(fiveHour) })
  if (week) windows.push({ minutes: WEEK, model: null, ...seconds(week) })
  if (family && info.utilization !== undefined && info.resetsAt !== undefined)
    windows.push({
      minutes: WEEK,
      model: family,
      ...seconds({ utilization: info.utilization, resetsAt: info.resetsAt }),
    })
  const warning =
    info.status === "allowed"
      ? null
      : {
          reached: info.status === "rejected",
          minutes: minutesOf(info.rateLimitType),
          model: family,
          resetsAt: info.resetsAt === undefined ? null : info.resetsAt * 1000,
          status: info.status,
          type: info.rateLimitType ?? "",
        }
  return [{ type: "limits", windows, warning }]
}

// The system lines that need nothing kept between lines; null for one this file does not take.
export function systemOf(message: Of<"system">): Draft[] | null {
  switch (message.subtype) {
    case "status":
      return statusOf(message)
    case "session_title_changed":
      return [{ type: "title", title: message.title }]
    case "compact_boundary": {
      const { pre_tokens: before, post_tokens: after } = message.compact_metadata
      return [{ type: "compacted", before: before ?? null, after: after ?? null }]
    }
    case "api_retry":
      return [
        {
          type: "retry",
          attempt: message.attempt,
          max: message.max_retries,
          delayMs: message.retry_delay_ms,
          status: message.error_status,
          reason: message.error,
        },
      ]
    // The command list is the input's business (controls.ts).
    case "commands_changed":
      return []
    case "init":
    case "local_command_output":
    case "background_tasks_changed":
    case "task_started":
    case "task_progress":
    case "task_updated":
    case "task_notification":
      break
  }
  return null
}

// What init, API errors and turn ends need kept between lines.
export function createSystem() {
  // The model init named; a result reports its context window under it.
  let model: string | null = null
  // A failed login shows its hint once, after the turn it failed.
  let loginNeeded = false
  let loginShown = false

  function init(message: System<"init">): Draft[] {
    model = message.model
    return [
      { type: "info", info: initInfo(message) },
      { type: "mode", mode: message.permissionMode },
    ]
  }

  // claude repeats an API error as a reply of its own, and the turn's end already shows it.
  function apiError(message: Of<"assistant">): Draft[] {
    const text = textOf(message.message.content)
    if (needsLogin(message.error, text)) loginNeeded = true
    return []
  }

  function result(message: Of<"result">): Draft[] {
    const out: Draft[] = []
    const window = model === null ? undefined : message.modelUsage?.[model]?.contextWindow
    if (window !== undefined) out.push({ type: "context.window", tokens: window })
    const errors = message.errors ?? []
    // claude's own diagnostic for a turn that stopped mid-way says nothing the user can act on.
    const stopped =
      message.subtype === "error_during_execution" &&
      !message.result &&
      errors.length > 0 &&
      errors.every((line) => line.startsWith("[ede_diagnostic]"))
    if (stopped) log.info("turn stopped during execution", errors.join("\n"))
    const reason = stopped ? "stopped during execution" : message.result || errors.join("\n") || message.subtype
    const usage = message.usage
    out.push({
      type: "turn.end",
      error: message.is_error ? reason : null,
      interrupted: false,
      local: !!message.local_command,
      durationMs: message.duration_ms,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      tokens:
        usage.input_tokens +
        usage.output_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      sessionCostUsd: message.total_cost_usd,
      prompts: message.user_message_uuids ?? [],
    })
    if (loginNeeded && !loginShown) {
      loginShown = true
      out.push({ type: "notice", level: "warning", text: LOGIN_HINT })
    }
    loginNeeded = false
    return out
  }

  return { init, apiError, result }
}
