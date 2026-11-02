import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { configPath } from "../config-path.ts"
import { log } from "../log/log.ts"

export type Permissions = "read-only" | "edits" | "inherit"

export type Definition = {
  name: string
  description: string
  provider: string | null
  model: string | null
  permissions: Permissions
  plugins: boolean
  instructions: string
  source: "built-in" | "global" | "project"
  // The file it came from, null for a built-in without one.
  path: string | null
  active: boolean
}

export type IsAvailable = (provider: string, model: string) => boolean

type Parsed = Omit<Definition, "name" | "source" | "path" | "active">

const PERMISSIONS: readonly Permissions[] = ["read-only", "edits", "inherit"]

type BuiltIn = Pick<Definition, "name" | "description" | "permissions" | "instructions">

const BUILT_INS: readonly BuiltIn[] = [
  {
    name: "general-purpose",
    description: "Handles a self-contained task end to end: research, multi-step work, or both.",
    permissions: "inherit",
    instructions:
      "You are working on one task handed over by another agent. Do the whole task, then reply with what you did and what you found. Keep the reply short: the other agent reads it, not the user.",
  },
  {
    name: "explore",
    description: "Searches and reads the codebase to answer a question. Changes nothing.",
    permissions: "read-only",
    instructions:
      "You answer a question about this codebase by searching and reading files. Do not change anything. Reply with the answer, the file paths that support it, and anything you could not find.",
  },
  {
    name: "worker",
    description: "Implements a well-defined change and reports what it changed.",
    permissions: "edits",
    instructions:
      "You implement one well-defined change. Follow the code style around you, keep the change to what was asked, and run the project's checks if there are any. Reply with the files you changed and anything left undone.",
  },
]

export function globalFolder(): string {
  return configPath("agents")
}

export function projectFolder(cwd: string): string {
  return join(cwd, ".yellowcode", "agents")
}

function splitFrontmatter(text: string): { front: string; body: string } | null {
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text)
  return match ? { front: match[1] ?? "", body: match[2] ?? "" } : null
}

function optionalString(value: unknown, key: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new Error(`${key} is not text`)
  return value.trim() || null
}

function parse(text: string): Parsed {
  const parts = splitFrontmatter(text)
  if (!parts) throw new Error("no frontmatter")
  const data: unknown = parts.front.trim() ? Bun.YAML.parse(parts.front) : {}
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("frontmatter is not a map")
  const fields = new Map<string, unknown>(Object.entries(data))
  const permissions = PERMISSIONS.find((value) => value === (fields.get("permissions") ?? "inherit"))
  if (!permissions) throw new Error("permissions is not read-only, edits or inherit")
  const plugins = fields.get("plugins") ?? false
  if (typeof plugins !== "boolean") throw new Error("plugins is not true or false")
  return {
    description: optionalString(fields.get("description"), "description") ?? "",
    provider: optionalString(fields.get("provider"), "provider"),
    model: optionalString(fields.get("model"), "model"),
    permissions,
    plugins,
    instructions: parts.body.trim(),
  }
}

function readFolder(folder: string, source: "global" | "project"): Omit<Definition, "active">[] {
  const found: Omit<Definition, "active">[] = []
  let names: string[]
  try {
    names = readdirSync(folder).filter((name) => name.endsWith(".md"))
  } catch {
    return found
  }
  for (const file of names.toSorted()) {
    const path = join(folder, file)
    try {
      found.push({
        ...parse(readFileSync(path, "utf8")),
        name: basename(file, ".md"),
        source,
        path,
      })
    } catch (error) {
      log.warn(`agent file skipped: ${path}`, error instanceof Error ? error.message : String(error))
    }
  }
  return found
}

// Same name: project over global over built-in.
export function loadDefinitions(cwd: string, isAvailable: IsAvailable): Definition[] {
  const merged = new Map<string, Definition>()
  const put = (entry: Omit<Definition, "active">) =>
    merged.set(entry.name, {
      ...entry,
      active: entry.provider !== null && entry.model !== null && isAvailable(entry.provider, entry.model),
    })
  for (const entry of BUILT_INS)
    put({ ...entry, provider: null, model: null, plugins: false, source: "built-in", path: null })
  for (const entry of readFolder(globalFolder(), "global")) put(entry)
  for (const entry of readFolder(projectFolder(cwd), "project")) put(entry)
  return [...merged.values()]
}

function yamlValue(value: string): string {
  return /^[\w./@-]+$/.test(value) ? value : JSON.stringify(value)
}

function setKey(front: string, key: string, value: string): string {
  const line = `${key}: ${yamlValue(value)}`
  const pattern = new RegExp(`^${key}:.*$`, "m")
  if (pattern.test(front)) return front.replace(pattern, line)
  return front ? `${front}\n${line}` : line
}

// Writes only the provider and model lines. A built-in without a file gets one in the global folder.
export function writeModel(name: string, provider: string, model: string, cwd: string = process.cwd()): void {
  const definition = loadDefinitions(cwd, () => false).find((entry) => entry.name === name)
  if (!definition) throw new Error(`no agent named ${name}`)
  if (definition.path) {
    const text = readFileSync(definition.path, "utf8")
    const parts = splitFrontmatter(text)
    if (!parts) throw new Error(`${definition.path} has no frontmatter`)
    const front = setKey(setKey(parts.front, "provider", provider), "model", model)
    writeFileSync(definition.path, `---\n${front}\n---\n${parts.body}`)
    return
  }
  const folder = globalFolder()
  mkdirSync(folder, { recursive: true })
  const front = [
    `description: ${JSON.stringify(definition.description)}`,
    `provider: ${yamlValue(provider)}`,
    `model: ${yamlValue(model)}`,
    `permissions: ${definition.permissions}`,
  ].join("\n")
  writeFileSync(join(folder, `${name}.md`), `---\n${front}\n---\n\n${definition.instructions}\n`)
}
