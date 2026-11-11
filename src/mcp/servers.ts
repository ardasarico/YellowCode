import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"
import { homePath } from "../paths.ts"
import { parseJson } from "../json.ts"
import { projectOf } from "../peers/project.ts"
import { OWN_AGENTS_SERVER, OWN_ASK_SERVER, OWN_SESSIONS_SERVER } from "../protocol/messages.ts"
import { MOD_SERVER_PREFIX } from "../mods/host.ts"

// YellowCode's one list of MCP servers, which it hands to whichever provider runs: mcp.json in its config folder and
// the project's .mcp.json, both in the mcpServers shape of Claude Code's .mcp.json.

export type McpScope = "global" | "project"

const strings = z.record(z.string(), z.string())
const StdioEntry = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: strings.optional(),
  cwd: z.string().optional(),
})
const RemoteEntry = z.object({ type: z.enum(["http", "sse"]), url: z.string().min(1), headers: strings.optional() })
const Entry = z.union([StdioEntry, RemoteEntry])
const JsonObject = z.record(z.string(), z.unknown())

// Unknown keys are dropped here and kept in the file.
export type McpEntry = z.output<typeof Entry>

export type McpFile = {
  path: string
  found: boolean
  servers: Record<string, McpEntry>
  // Every name under mcpServers, the ones that do not fit included.
  names: string[]
  // Names the file and the rule or entry that does not fit; never a value.
  problems: string[]
  // Of the file's mcpServers as written, unexpanded; see trust.ts.
  fingerprint: string
}

export type SharedServer = { name: string; scope: McpScope; entry: McpEntry }

export const GLOBAL_FILE = "mcp.json"
export const PROJECT_FILE = ".mcp.json"
export const globalFile = () => homePath(GLOBAL_FILE)

const NAME = /^[A-Za-z0-9_-]{1,32}$/
// opencode serves the ask under OWN_ASK_SERVER too.
const OWN_NAMES = new Set([OWN_ASK_SERVER, OWN_SESSIONS_SERVER, OWN_AGENTS_SERVER])

// Every provider makes tool names from the server name, each changes other characters its own way, and a tool name
// has at most 64 characters.
export function nameRule(name: string): string | null {
  if (!NAME.test(name)) return "a name has 1 to 32 letters, digits, - or _"
  const lower = name.toLowerCase()
  if (OWN_NAMES.has(lower) || lower.startsWith(MOD_SERVER_PREFIX))
    return "YellowCode uses that name for its own servers"
  return null
}

export function nameProblem(name: string): string | null {
  const rule = nameRule(name)
  return rule && `${NAME.test(name) ? name : JSON.stringify(name)}: ${rule}`
}

// The nearest .mcp.json from cwd up to the project's root, or null.
export function findProjectFile(cwd: string): string | null {
  const root = projectOf(cwd)
  let dir = realOr(cwd)
  for (;;) {
    const path = join(dir, PROJECT_FILE)
    if (existsSync(path)) return path
    const parent = dirname(dir)
    if (dir === root || parent === dir || !dir.startsWith(root)) return null
    dir = parent
  }
}

// Every name under mcpServers of every .mcp.json from cwd up to /, as written, the ones YellowCode rejects included:
// Claude Code reads them all by itself. Null when a file is there whose names cannot be read for sure.
export function ancestorNames(cwd: string): string[] | null {
  const names = new Set<string>()
  for (const start of new Set([cwd, realOr(cwd)]))
    for (let dir = start; ; dir = dirname(dir)) {
      const raw = readRaw(join(dir, PROJECT_FILE))
      if (!raw.ok) return null
      const listed = raw.json?.["mcpServers"]
      if (listed !== undefined) {
        const list = JsonObject.safeParse(listed)
        if (!list.success) return null
        for (const name of Object.keys(list.data)) names.add(name)
      }
      if (dirname(dir) === dir) break
    }
  return [...names]
}

// Where `add --project` writes when the project has no .mcp.json yet.
export const newProjectFile = (cwd: string) => join(projectOf(cwd), PROJECT_FILE)

function realOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

type Raw = { ok: true; json: Record<string, unknown> | null } | { ok: false; problem: string }

const MAX_BYTES = 1024 * 1024

// Only a regular file of at most MAX_BYTES: a device or a pipe in its place would hold up every start. The open does
// not wait for a pipe's writer.
function readText(path: string): string | null | { problem: string } {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    return { problem: `${path} cannot be read` }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { problem: `${path} is not a file` }
    if (stat.size > MAX_BYTES) return { problem: `${path} is larger than 1 MB` }
    // The file can grow after the stat, so the read stops past the limit.
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let read = 0
    for (let got = 1; got > 0 && read < buffer.length; read += got)
      got = readSync(fd, buffer, read, buffer.length - read, null)
    if (read > MAX_BYTES) return { problem: `${path} is larger than 1 MB` }
    return buffer.toString("utf8", 0, read)
  } catch {
    return { problem: `${path} cannot be read` }
  } finally {
    closeSync(fd)
  }
}

// The file's top-level object, null when there is no file.
function readRaw(path: string): Raw {
  const text = readText(path)
  if (text === null) return { ok: true, json: null }
  if (typeof text !== "string") return { ok: false, problem: text.problem }
  // The parser's message can quote the file, which may hold a secret.
  const parsed = parseJson(text.replace(/^﻿/, ""))
  if (!parsed.ok) return { ok: false, problem: `${path} is not valid JSON` }
  const object = JsonObject.safeParse(parsed.value)
  return object.success ? { ok: true, json: object.data } : { ok: false, problem: `${path} is not a JSON object` }
}

export const EMPTY_CWD = "cwd is empty"

export function readMcpFile(path: string): McpFile {
  const raw = readRaw(path)
  const empty = { path, servers: {}, names: [], fingerprint: fingerprintOf(undefined) }
  if (!raw.ok) return { ...empty, found: true, problems: [raw.problem] }
  if (raw.json === null) return { ...empty, found: false, problems: [] }
  const list = raw.json["mcpServers"]
  const fingerprint = fingerprintOf(list)
  if (list === undefined) return { ...empty, found: true, problems: [] }
  const entries = JsonObject.safeParse(list)
  if (!entries.success)
    return { ...empty, fingerprint, found: true, problems: [`${path}: mcpServers is not an object`] }
  const servers: Record<string, McpEntry> = {}
  const problems: string[] = []
  for (const [name, value] of Object.entries(entries.data)) {
    const problem = nameProblem(name)
    if (problem) {
      problems.push(`${path}: ${problem}`)
      continue
    }
    const entry = Entry.safeParse(value)
    if (entry.success && "command" in entry.data && entry.data.cwd === "")
      problems.push(`${path}: ${name}: ${EMPTY_CWD}`)
    else if (entry.success) servers[name] = entry.data
    else
      problems.push(`${path}: ${name} takes command, args, env and cwd, or type "http" or "sse" with url and headers`)
  }
  return { path, found: true, servers, names: Object.keys(entries.data), problems, fingerprint }
}

// A project entry replaces the global one of its name whole.
export function mergeServers(global: McpFile, project: McpFile | null): SharedServer[] {
  const merged = new Map<string, SharedServer>()
  for (const [name, entry] of Object.entries(global.servers)) merged.set(name, { name, scope: "global", entry })
  for (const [name, entry] of Object.entries(project?.servers ?? {}))
    merged.set(name, { name, scope: "project", entry })
  return [...merged.values()]
}

// Sorted keys, so the same servers written in another order keep their fingerprint.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const object = JsonObject.safeParse(value)
  if (object.success)
    return `{${Object.keys(object.data)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(object.data[key])}`)
      .join(",")}}`
  return JSON.stringify(value ?? null)
}

function fingerprintOf(servers: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonical(servers ?? {})).digest("hex")
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

export const hasReference = (value: string) => new RegExp(REFERENCE.source).test(value)

type Expanded<T> = { ok: true; value: T } | { ok: false; missing: string[] }

// ${VAR} and ${VAR:-default} from env; a default also stands in for an empty value, as in the shell.
function expandText(text: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return text.replace(REFERENCE, (_match, name: string, fallback: string | undefined) => {
    const value = env[name]
    if (fallback !== undefined) return value ? value : fallback
    if (value === undefined) missing.add(name)
    return value ?? ""
  })
}

export function expandEntry(entry: McpEntry, env: NodeJS.ProcessEnv): Expanded<McpEntry> {
  const missing = new Set<string>()
  const text = (value: string) => expandText(value, env, missing)
  const values = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, text(value)]))
  const expanded: McpEntry =
    "command" in entry
      ? {
          ...entry,
          command: text(entry.command),
          ...(entry.args && { args: entry.args.map(text) }),
          ...(entry.env && { env: values(entry.env) }),
          ...(entry.cwd !== undefined && { cwd: text(entry.cwd) }),
        }
      : { ...entry, url: text(entry.url), ...(entry.headers && { headers: values(entry.headers) }) }
  return missing.size > 0 ? { ok: false, missing: [...missing] } : { ok: true, value: expanded }
}

export const needsProblem = (missing: string[]) => `needs ${missing.map((name) => `$${name}`).join(", ")}`

// `fingerprint`: of the mcpServers just written.
export type WriteResult = { ok: true; replaced: boolean; fingerprint: string } | { ok: false; problem: string }

// Puts `entry` under `name`, or takes the name out when entry is null, keeping everything else in the file.
export function writeServer(path: string, name: string, entry: Record<string, unknown> | null): WriteResult {
  const raw = readRaw(path)
  if (!raw.ok) return { ok: false, problem: `${raw.problem}; fix it first` }
  const json = raw.json ?? {}
  const listed = json["mcpServers"] ?? {}
  const parsed = JsonObject.safeParse(listed)
  if (!parsed.success) return { ok: false, problem: `${path}: mcpServers is not an object; fix it first` }
  const servers = parsed.data
  const replaced = name in servers
  if (entry === null) delete servers[name]
  else servers[name] = entry
  json["mcpServers"] = servers
  const target = realOr(path)
  const temp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(temp, `${JSON.stringify(json, null, 2)}\n`)
    renameSync(temp, target)
    return { ok: true, replaced, fingerprint: fingerprintOf(servers) }
  } catch (error) {
    rmSync(temp, { force: true })
    return { ok: false, problem: `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}
