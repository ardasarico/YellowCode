// The MCP servers a thread starts with, as config overrides of thread/start. Codex lays them over the servers of its
// own config.toml field by field: a scalar or list is replaced, but a map keeps every key the override does not name,
// and no field can be taken away. So a server of ours with the name of one of Codex's own overrides each field the
// other has, and where that cannot be done it does not go in at all.
import { z } from "zod"
import type { McpLaunch, OwnMcp } from "../../agent/agent.ts"
import { identityOf, sameServer, type ServerIdentity } from "../../source/safe-text.ts"

// What YellowCode keeps of one of Codex's own servers: its kind, the names of its fields and of its maps' keys, and
// what it runs (null when the layers do not agree on it). The values (env, headers) are never kept.
export type OwnServer = {
  url: boolean
  fields: Set<string>
  keys: Record<MapField, Set<string>>
  identity: ServerIdentity | null
}

const MAPS = ["env", "http_headers", "env_http_headers"] as const
type MapField = (typeof MAPS)[number]

// Fields an override replaces or empties. Any other, such as bearer_token_env_var or enabled_tools, would go on
// working for our server with no way to undo it.
const REPLACED = new Set([
  "command",
  "args",
  "cwd",
  "env_vars",
  "url",
  "enabled",
  "disabled_tools",
  ...MAPS,
  "startup_timeout_sec",
  "startup_timeout_ms",
  "tool_timeout_sec",
  "required",
])

const STARTUP_TIMEOUT_SEC = 10
const TOOL_TIMEOUT_SEC = 60

const layers = z.looseObject({
  config: z
    .looseObject({ mcp_servers: z.record(z.string(), z.unknown()).optional() })
    .nullable()
    .optional(),
  layers: z
    .array(z.looseObject({ config: z.looseObject({ mcp_servers: z.record(z.string(), z.unknown()).optional() }) }))
    .nullable()
    .optional(),
})
const record = z.record(z.string(), z.unknown())

// Every server of every layer of config/read with includeLayers; the reply holds env and header values, which go no
// further than this.
export function ownServers(reply: unknown): Map<string, OwnServer> {
  const own = new Map<string, OwnServer>()
  const parsed = layers.safeParse(reply).data
  // The merged config says what runs; a layer only when no other one says otherwise.
  const runs = new Map<string, ServerIdentity | null>()
  for (const layer of parsed?.layers ?? [])
    for (const [name, value] of Object.entries(layer.config.mcp_servers ?? {})) {
      const identity = identityOf(value)
      if (!identity) continue
      const known = runs.get(name)
      runs.set(name, known === undefined || (known && sameServer(known, identity) === true) ? identity : null)
    }
  for (const [name, value] of Object.entries(parsed?.config?.mcp_servers ?? {})) {
    const identity = identityOf(value)
    if (identity) runs.set(name, identity)
  }
  for (const layer of parsed?.layers ?? []) {
    for (const [name, value] of Object.entries(layer.config.mcp_servers ?? {})) {
      const entry = record.safeParse(value).data
      if (!entry) continue
      const server = own.get(name) ?? {
        url: false,
        fields: new Set<string>(),
        keys: { env: new Set<string>(), http_headers: new Set<string>(), env_http_headers: new Set<string>() },
        identity: runs.get(name) ?? null,
      }
      for (const field of Object.keys(entry)) server.fields.add(field)
      if ("url" in entry) server.url = true
      for (const map of MAPS)
        for (const key of Object.keys(record.safeParse(entry[map]).data ?? {})) server.keys[map].add(key)
      own.set(name, server)
    }
  }
  return own
}

const otherKind = (name: string) =>
  `Codex has its own ${name} of another kind, so ${name} is off here. Remove it from Codex's config to use the shared one.`
const unreplaceable = (name: string) =>
  `Codex has its own ${name} with settings the shared one cannot replace, so ${name} is off here. Remove it from Codex's config to use the shared one.`
const noSse = (name: string) => `Codex cannot connect to an SSE server, so ${name} is off here.`

// An empty value is the nearest to taking a key away: an env variable or header goes out empty, and an
// env_http_headers entry with no variable name sends no header.
const blank = (keys: Set<string>, kept: Record<string, string>) =>
  Object.fromEntries([...keys].filter((key) => !(key in kept)).map((key) => [key, ""]))

const isEmptyMap = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0

function fieldsOf(server: McpLaunch, own: OwnServer | undefined, cwd: string): Record<string, unknown> {
  const fields: Record<string, unknown> =
    "url" in server
      ? {
          url: server.url,
          http_headers: { ...(own && blank(own.keys.http_headers, server.headers)), ...server.headers },
        }
      : {
          command: server.command,
          args: server.args,
          env: { ...(own && blank(own.keys.env, server.env)), ...server.env },
          ...(server.cwd !== undefined ? { cwd: server.cwd } : own?.fields.has("cwd") ? { cwd } : {}),
        }
  if (own) {
    fields["enabled"] = true
    if (own.keys.env_http_headers.size > 0) fields["env_http_headers"] = blank(own.keys.env_http_headers, {})
    if (own.fields.has("env_vars")) fields["env_vars"] = []
    if (own.fields.has("disabled_tools")) fields["disabled_tools"] = []
    if (own.fields.has("required")) fields["required"] = false
    // Codex's defaults; startup_timeout_sec wins over startup_timeout_ms.
    if (own.fields.has("startup_timeout_sec") || own.fields.has("startup_timeout_ms"))
      fields["startup_timeout_sec"] = STARTUP_TIMEOUT_SEC
    if (own.fields.has("tool_timeout_sec")) fields["tool_timeout_sec"] = TOOL_TIMEOUT_SEC
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => !isEmptyMap(value)))
}

// `replaced`: the own servers ours stand in for, and whether the own one is another server (null: cannot tell).
export type ThreadMcp = {
  config: Record<string, unknown>
  held: { name: string; problem: string }[]
  replaced: { name: string; different: boolean | null }[]
}

// `servers` win over Codex's own of their name; with `ownMcp.on` false every other own one is switched off.
export function threadMcp(
  servers: readonly McpLaunch[],
  own: ReadonlyMap<string, OwnServer>,
  ownMcp: OwnMcp | undefined,
  cwd: string,
): ThreadMcp {
  const config: Record<string, unknown> = {}
  const held: ThreadMcp["held"] = []
  const replaced: ThreadMcp["replaced"] = []
  const off = (name: string) => {
    if (own.has(name)) config[`mcp_servers.${name}.enabled`] = false
  }
  for (const server of servers) {
    const mine = own.get(server.name)
    const problem =
      "url" in server && server.type === "sse"
        ? noSse(server.name)
        : mine && mine.url !== "url" in server
          ? otherKind(server.name)
          : mine && [...mine.fields].some((field) => !REPLACED.has(field))
            ? unreplaceable(server.name)
            : null
    if (problem) {
      held.push({ name: server.name, problem })
      off(server.name)
      continue
    }
    config[`mcp_servers.${server.name}`] = fieldsOf(server, mine, cwd)
    if (!mine) continue
    const ours = identityOf(server)
    const same = ours && mine.identity ? sameServer(ours, mine.identity) : null
    replaced.push({ name: server.name, different: same === null ? null : !same })
  }
  if (ownMcp && !ownMcp.on) {
    const given = new Set(servers.map((server) => server.name))
    for (const name of own.keys()) if (!given.has(name)) off(name)
  }
  return { config, held, replaced }
}

// Codex's own servers matter only when ours could meet one of them, or when they are to be switched off.
export const needsOwn = (servers: readonly McpLaunch[], ownMcp: OwnMcp | undefined) =>
  servers.length > 0 || ownMcp?.on === false
