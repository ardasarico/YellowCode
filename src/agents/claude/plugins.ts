// The plugins Claude Code would load for a session in `cwd`, by the id its settings name them with. Claude has no
// switch for all of them, so a session that leaves them off names each one.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"
import { parseJson } from "../../json.ts"
import { log } from "../../log/log.ts"
import { projectOf } from "../../peers/project.ts"
import { CLAUDE_HOME } from "./projects.ts"

const keyed = z.record(z.string(), z.unknown())

// Null for a file that is missing or cannot be read.
function read(path: string): Record<string, unknown> | null {
  try {
    const json = parseJson(readFileSync(path, "utf8"))
    return json.ok ? (keyed.safeParse(json.value).data ?? null) : null
  } catch {
    return null
  }
}

const keysOf = (path: string, field: string) => Object.keys(keyed.safeParse(read(path)?.[field]).data ?? {})

// A plugin folder inside a skills folder is listed nowhere else. Its id takes the manifest's name; the folder's
// name goes along in case they differ.
function inSkills(folder: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(folder)
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const manifest = read(join(folder, entry, ".claude-plugin", "plugin.json"))
    if (!manifest) return []
    const { name } = manifest
    return [entry, ...(typeof name === "string" && name !== entry ? [name] : [])].map((id) => `${id}@skills-dir`)
  })
}

// Claude Code reads the skills folders from the start folder up to the git root, or up to / outside a repository.
function projectSkills(cwd: string): string[] {
  const root = projectOf(cwd)
  const inRepo = existsSync(join(root, ".git"))
  let start = cwd
  try {
    start = realpathSync(cwd)
  } catch {}
  const folders: string[] = []
  for (let dir = start; ; dir = dirname(dir)) {
    folders.push(join(dir, ".claude", "skills"))
    if ((inRepo && dir === root) || dirname(dir) === dir) break
  }
  return folders
}

// The ids go out as one argument, and a project's files can name any number of any length.
const MOST_IDS = 500
const LONGEST_ID = 200

// A file that gives nothing gives no ids, so reading never fails a start. Claude Code's built-in plugins stay on.
export function installedPlugins(cwd: string, home = CLAUDE_HOME): string[] {
  const settings = [
    join(home, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ]
  const found = [
    ...new Set([
      ...keysOf(join(home, "plugins", "installed_plugins.json"), "plugins"),
      ...inSkills(join(home, "skills")),
      ...projectSkills(cwd).flatMap(inSkills),
      ...settings.flatMap((path) => keysOf(path, "enabledPlugins")),
    ]),
  ].filter((id) => !id.endsWith("@builtin"))
  const kept = found.filter((id) => id.length <= LONGEST_ID).slice(0, MOST_IDS)
  if (kept.length < found.length) log.warn("too many plugins to switch off", { found: found.length, kept: kept.length })
  return kept.toSorted()
}
