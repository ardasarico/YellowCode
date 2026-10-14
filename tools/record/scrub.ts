import { z } from "zod"
import { parseJson } from "../../src/protocol/json.ts"
import { SETTINGS_ID, SKILLS_DIALOG_ID } from "../../src/source/recording.ts"

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
const SOURCE_LABEL = / \((user|project|cli flag|claude\.ai sync|managed|dynamic workflow)\)$/

const letter = (index: number) => String.fromCharCode(97 + index)
const short = (name: string) => name.slice(name.indexOf(":") + 1)

export function keptNames(files: Record<string, string> = {}): string[] {
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
        : name.includes(":")
          ? "plugin skill"
          : "user skill"
  return `Sample ${kind}; its real name and description were replaced when it was recorded.`
}

export type Names = ReturnType<typeof createNames>

// The user's own skills, plugins and agents become fake names, the same ones across a recording. Claude Code's
// built-in names and the names the scenario creates stay. Only the first few claude.ai skills are kept.
export function createNames(keep: Iterable<string>) {
  const kept = new Set(keep)
  const builtin = new Set<string>()
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
    if (!marketplaces.has(marketplace)) marketplaces.set(marketplace, `marketplace-${letter(marketplaces.size)}`)
    return `${plugin(name)}@${marketplaces.get(marketplace)}`
  }

  function rename(name: string, kind: "skill" | "agent"): string | null {
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

  const skill = (name: string) => rename(name, "skill")
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
    skill,
    listed,
    agent,
    pluginId,
    aliasesFor,
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
    const { skills, slash_commands, agents } = initLists.parse(init.data)
    const rewritten = {
      ...init.data,
      plugins: [],
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
