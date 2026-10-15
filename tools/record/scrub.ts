import { z } from "zod"
import { parseJson } from "../../src/protocol/json.ts"
import { HOOKS_ID, SETTINGS_ID, SKILLS_DIALOG_ID } from "../../src/source/recording.ts"

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
const initLine = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  plugins: z.unknown(),
  messaging_socket_path: z.string().optional(),
})
const initLists = z.looseObject({
  skills: z.array(z.string()).optional(),
  slash_commands: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  // Keys in the order claude sends them, so a scrubbed line scrubs to itself.
  mcp_servers: z
    .array(z.looseObject({ name: z.string(), status: z.string().optional(), source: z.string().optional() }))
    .optional(),
  plugins: z
    .array(z.looseObject({ name: z.string(), path: z.string().optional(), source: z.string().optional() }))
    .optional(),
})
const command = z.looseObject({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  builtin: z.boolean().optional(),
})
const commandsReply = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({ response: z.looseObject({ commands: z.unknown() }) }),
})
const skillRow = z.looseObject({
  name: z.string(),
  display_name: z.string(),
  description: z.string(),
  handles: z.looseObject({ unqualified_name: z.string().optional(), aliases: z.array(z.string()).optional() }),
})
const skillsReply = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({
    request_id: z.literal(SKILLS_DIALOG_ID),
    response: z.looseObject({ skills: z.array(z.unknown()) }),
  }),
})

// Settings hold permission rules and env, so only the fields the skills dialog reads are kept.
const settingsReply = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({
    subtype: z.string(),
    request_id: z.literal(SETTINGS_ID),
    error: z.string().optional(),
    response: z.unknown(),
  }),
})
// Hook rows hold the commands they run, so only the plugin, event and matcher of plugin hooks are kept.
const hooksReply = z.looseObject({
  type: z.literal("control_response"),
  response: z.looseObject({
    subtype: z.string(),
    request_id: z.literal(HOOKS_ID),
    error: z.string().optional(),
    response: z.unknown(),
  }),
})
const hookRows = z.looseObject({
  hooks: z.array(
    z.looseObject({ event: z.string(), matcher: z.string().optional(), pluginName: z.string().optional() }),
  ),
})
const settingsSources = z.looseObject({
  sources: z.array(
    z.looseObject({
      source: z.string(),
      settings: z
        .looseObject({
          enabledPlugins: z.record(z.string(), z.unknown()).optional(),
          skillOverrides: z.record(z.string(), z.unknown()).optional(),
        })
        .nullish(),
    }),
  ),
})

const SYNCED = "anthropic-skills"
const SYNCED_KEPT = 4
const BUILTIN_AGENTS = new Set([
  "claude",
  "claude-code-guide",
  "Explore",
  "general-purpose",
  "Plan",
  "statusline-setup",
])
// Claude Code's own tags for plugins that come from no marketplace.
const PLUGIN_ORIGINS = new Set(["inline", "synced", "builtin"])
export const SAMPLE_SERVER =
  /^(echo|broken|postgres|claude-in-chrome|server-[a-z]|plugin:plugin-[a-z]:(plugin|server)-[a-z]|claude\.ai Connector [A-Z])$/
// SAMPLE_SERVER names as they appear in MCP tool names.
const SAMPLE_TOOL =
  /^mcp__(echo|broken|postgres|claude-in-chrome|server-[a-z]|plugin_plugin-[a-z]_(plugin|server)-[a-z]|claude_ai_Connector_[A-Z])__[\w-]*$/
// Claude Code's built-in tool names and the SessionStart and PreCompact matcher values.
const BUILTIN_MATCHERS = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "LSP",
  "Monitor",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "SendMessage",
  "Skill",
  "Task",
  "TaskStop",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
  "startup",
  "resume",
  "clear",
  "compact",
  "manual",
  "auto",
])
const SOURCE_LABEL = / \((user|project|cli flag|claude\.ai sync|managed|dynamic workflow)\)$/

const letter = (index: number) => String.fromCharCode(97 + index)
const short = (name: string) => name.slice(name.indexOf(":") + 1)
const toolPrefix = (server: string) => `mcp__${server.replace(/[^\w-]/g, "_")}__`

export function keptNames(files: Record<string, unknown> = {}): string[] {
  return Object.keys(files).flatMap((path) => {
    const match = /^\.claude\/(?:skills\/([^/]+)\/SKILL\.md|(?:commands|agents)\/([^/]+)\.md)$/.exec(path)
    const name = match?.[1] ?? match?.[2]
    return name === undefined ? [] : [name]
  })
}

function sampleDescription(name: string): string {
  const kind =
    name.startsWith(`${SYNCED}:`) || name.startsWith("synced-")
      ? "claude.ai skill"
      : name.includes(":agent-")
        ? "plugin agent"
        : name.includes(":command-")
          ? "plugin command"
          : name.includes(":")
            ? "plugin skill"
            : "user skill"
  return `Sample ${kind}; its real name and description were replaced when it was recorded.`
}

export type Names = ReturnType<typeof createNames>

// The user's own skills, plugins, agents and MCP servers become fake names, the same ones across a recording.
// Claude Code's built-in names and the names the scenario creates stay. Only the first few claude.ai skills are kept.
export function createNames(keep: Iterable<string>) {
  const kept = new Set(keep)
  const builtin = new Set<string>()
  const skills = new Set<string>()
  const fake = new Map<string, string | null>()
  const plugins = new Map<string, string>()
  const marketplaces = new Map<string, string>()
  const counts = new Map<string, number>()
  const next = (key: string) => {
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    return count
  }
  const fixed = (name: string) => kept.has(name) || builtin.has(name)

  const plugin = (name: string) => {
    if (!plugins.has(name)) plugins.set(name, `plugin-${letter(plugins.size)}`)
    return plugins.get(name) ?? name
  }
  const pluginId = (id: string) => {
    const [name = id, marketplace] = id.split("@")
    if (marketplace === undefined) return plugin(name)
    if (PLUGIN_ORIGINS.has(marketplace)) return `${plugin(name)}@${marketplace}`
    if (!marketplaces.has(marketplace)) marketplaces.set(marketplace, `marketplace-${letter(marketplaces.size)}`)
    return `${plugin(name)}@${marketplaces.get(marketplace)}`
  }

  const servers = new Map<string, string>()
  const toolPrefixes = new Map<string, string>()
  const sampleServer = () => `server-${letter(next("server") - 1)}`
  const server = (name: string, source: string | undefined) => {
    if (SAMPLE_SERVER.test(name)) return name
    const known = servers.get(name)
    if (known !== undefined) return known
    const [kind, owner, inner] = name.split(":")
    let out: string
    if (source === "plugin" && kind === "plugin" && owner && inner) {
      out = `plugin:${plugin(owner)}:${inner === owner ? plugin(owner) : sampleServer()}`
    } else if (source === "claudeai") {
      out = `claude.ai Connector ${letter(next("connector") - 1).toUpperCase()}`
    } else {
      out = sampleServer()
    }
    servers.set(name, out)
    toolPrefixes.set(toolPrefix(name), toolPrefix(out))
    return out
  }
  const tool = (name: string) => {
    for (const [real, renamed] of toolPrefixes) if (name.startsWith(real)) return `${renamed}tool-${next(renamed)}`
    return name
  }
  // A matcher is kept only when every name in it is built-in, a sample, or a known MCP name; otherwise it is replaced.
  const matcher = (value: string) => {
    if (/^matcher-\d+$/.test(value)) return value
    let known = true
    const out = value.replace(/[\w-]+/g, (word) => {
      if (BUILTIN_MATCHERS.has(word) || SAMPLE_TOOL.test(word)) return word
      const prefix = toolPrefixes.get(word)
      if (prefix !== undefined) return prefix
      const renamed = tool(word)
      if (renamed === word) known = false
      return renamed
    })
    return known ? out : `matcher-${next("matcher")}`
  }

  function rename(name: string, kind: "skill" | "command" | "agent"): string | null {
    if (fixed(name)) return name
    const known = fake.get(name)
    if (known !== undefined) return known
    const colon = name.indexOf(":")
    let out: string | null
    if (colon > 0 && name.slice(0, colon) === SYNCED) {
      const count = (counts.get("synced") ?? 0) < SYNCED_KEPT ? next("synced") : null
      out = count === null ? null : `${SYNCED}:synced-skill-${count}`
      const bare = short(name)
      if (!fixed(bare) && !fake.has(bare)) fake.set(bare, out === null ? null : short(out))
    } else if (colon > 0) {
      const owner = plugin(name.slice(0, colon))
      out = `${owner}:${kind}-${next(`${owner}:${kind}`)}`
    } else if (kind === "agent") {
      out = BUILTIN_AGENTS.has(name) ? name : `user-agent-${next("agent")}`
    } else {
      out = `user-skill-${next("skill")}`
    }
    fake.set(name, out)
    return out
  }

  // A plugin name that init does not list as a skill is one of the plugin's commands.
  const skill = (name: string) => rename(name, name.includes(":") && !skills.has(name) ? "command" : "skill")
  // Without a commands reply first, a plain name in the init lists cannot be told from a built-in one.
  const listed = (name: string) => (name.includes(":") || fake.has(name) ? skill(name) : name)
  const agent = (name: string) => rename(name, "agent")

  const aliasesFor = (real: string, renamed: string, aliases: string[]) =>
    aliases.flatMap((alias) => {
      const out = alias === short(real) ? short(renamed) : listed(alias)
      return out === null ? [] : [out]
    })

  return {
    learnBuiltins(names: string[]) {
      for (const name of names) builtin.add(name)
    },
    learnSkills(names: string[]) {
      for (const name of names) skills.add(name)
    },
    skill,
    listed,
    agent,
    plugin,
    pluginId,
    server,
    tool,
    matcher,
    aliasesFor,
  }
}

// The commands reply comes before init, so init's skills list is read from the whole recording first.
export function learnSkills(lines: string[], names: Names) {
  for (const line of lines) {
    const json = parseJson(line)
    const init = json.ok ? initLine.safeParse(json.value) : null
    if (init?.success) names.learnSkills(initLists.parse(init.data).skills ?? [])
  }
}

const present = <T>(value: T | null): value is T => value !== null

function renameCommand(value: unknown, names: Names): unknown {
  const entry = command.safeParse(value)
  if (!entry.success || entry.data.builtin) return value
  const { name, description, aliases, argumentHint } = entry.data
  for (const alias of aliases ?? []) if (alias.includes(":")) names.skill(alias)
  const renamed = names.skill(name)
  if (renamed === null) return null
  if (renamed === name) return value
  const prefix =
    renamed.includes(":") && !renamed.startsWith(`${SYNCED}:`) ? `(${renamed.slice(0, renamed.indexOf(":"))}) ` : ""
  const label = SOURCE_LABEL.exec(description)?.[0] ?? ""
  return {
    ...entry.data,
    name: renamed,
    description: `${prefix}${sampleDescription(renamed)}${label}`,
    ...(argumentHint === undefined ? {} : { argumentHint: "" }),
    ...(aliases === undefined ? {} : { aliases: names.aliasesFor(name, renamed, aliases) }),
  }
}

function renameRow(value: unknown, names: Names): unknown {
  const row = skillRow.safeParse(value)
  if (!row.success) return value
  const { name, display_name, handles } = row.data
  const renamed = names.skill(name)
  if (renamed === null) return null
  if (renamed === name) return value
  const { unqualified_name, aliases } = handles
  return {
    ...row.data,
    name: renamed,
    display_name: display_name === name ? renamed : short(renamed),
    description: sampleDescription(renamed),
    handles: {
      ...handles,
      ...(unqualified_name === undefined ? {} : { unqualified_name: short(renamed) }),
      ...(aliases === undefined ? {} : { aliases: names.aliasesFor(name, renamed, aliases) }),
    },
  }
}

const renameKeys = (record: Record<string, unknown> | undefined, rename: (key: string) => string | null) =>
  record &&
  Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) => {
      const renamed = rename(key)
      return renamed === null ? [] : [[renamed, value]]
    }),
  )

export function rewrite(line: string, names: Names): string {
  const json = parseJson(line)
  if (!json.ok) return line
  const init = initLine.safeParse(json.value)
  if (init.success) {
    const { skills, slash_commands, agents, tools, mcp_servers, plugins } = initLists.parse(init.data)
    for (const entry of plugins ?? []) {
      entry.name = names.plugin(entry.name)
      entry.path = `/plugins/${entry.name}`
      if (entry.source !== undefined) entry.source = names.pluginId(entry.source)
    }
    for (const entry of mcp_servers ?? []) entry.name = names.server(entry.name, entry.source)
    const rewritten = {
      ...init.data,
      plugins: plugins ?? [],
      ...(mcp_servers && { mcp_servers }),
      ...(tools && { tools: tools.map(names.tool) }),
      ...(skills && { skills: skills.map(names.listed).filter(present) }),
      ...(slash_commands && { slash_commands: slash_commands.map(names.listed).filter(present) }),
      ...(agents && { agents: agents.map(names.agent).filter(present) }),
    }
    if (rewritten.messaging_socket_path !== undefined) rewritten.messaging_socket_path = "/tmp/cc-socks/0.sock"
    return JSON.stringify(rewritten)
  }
  const settingsLine = settingsReply.safeParse(json.value)
  if (settingsLine.success) {
    const { subtype, request_id, error, response } = settingsLine.data.response
    const sources = settingsSources.safeParse(response)
    const kept = sources.success
      ? {
          sources: sources.data.sources.map(({ source, settings }) => ({
            source,
            settings: {
              enabledPlugins: renameKeys(settings?.enabledPlugins, names.pluginId),
              skillOverrides: renameKeys(settings?.skillOverrides, names.skill),
            },
          })),
        }
      : undefined
    return JSON.stringify({ type: "control_response", response: { subtype, request_id, error, response: kept } })
  }
  const hooksLine = hooksReply.safeParse(json.value)
  if (hooksLine.success) {
    const { subtype, request_id, error, response } = hooksLine.data.response
    const rows = hookRows.safeParse(response)
    const kept = rows.success
      ? {
          hooks: rows.data.hooks.flatMap(({ event, matcher, pluginName }) =>
            pluginName === undefined
              ? []
              : [{ pluginName: names.pluginId(pluginName), event, matcher: names.matcher(matcher ?? "") }],
          ),
        }
      : undefined
    return JSON.stringify({ type: "control_response", response: { subtype, request_id, error, response: kept } })
  }
  const skillsLine = skillsReply.safeParse(json.value)
  if (skillsLine.success) {
    const { response } = skillsLine.data
    const skills = response.response.skills.map((row) => renameRow(row, names)).filter(present)
    return JSON.stringify({ ...skillsLine.data, response: { ...response, response: { ...response.response, skills } } })
  }
  const reply = commandsReply.safeParse(json.value)
  if (reply.success) {
    const { response } = reply.data
    const list = z.array(z.unknown()).safeParse(response.response.commands)
    const builtins = list.data?.flatMap((entry) => {
      const parsed = command.safeParse(entry)
      return parsed.data?.builtin ? [parsed.data.name] : []
    })
    names.learnBuiltins(builtins ?? [])
    const commands =
      list.data?.map((entry) => renameCommand(entry, names)).filter(present) ?? response.response.commands
    return JSON.stringify({ ...reply.data, response: { ...response, response: { commands } } })
  }
  return line
}

type ScrubPaths = { workDirs: string[]; home: string; username: string; uid: number }

export function scrub(line: string, paths: ScrubPaths, names: Names = createNames([])): string {
  let out = line
  for (const dir of paths.workDirs) {
    out = out.replaceAll(dir.replaceAll("/", "-"), "-Users-user-project")
    out = out.replaceAll(dir, "/Users/user/project")
  }
  for (const prefix of ["/private/tmp", "/tmp"])
    out = out.replaceAll(`${prefix}/claude-${paths.uid}`, "/tmp/claude-user")
  out = out.replaceAll(paths.home, "/Users/user").replaceAll(paths.username, "user").replace(EMAIL, "user@example.com")
  return rewrite(out, names)
}
