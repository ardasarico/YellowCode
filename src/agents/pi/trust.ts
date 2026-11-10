// Pi loads a project's own files only from a folder it trusts, and over RPC it skips them without a word. Read only,
// worked out the way pi 1.4 does it (its core/trust-manager.js).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { parseJson } from "../../json.ts"
import { agentDir } from "./sessions.ts"

// What pi looks for in the folder's own .pi; parents' .pi folders do not count.
const PI_FILES = [
  "settings.json",
  "mcp.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
]

const canonical = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

// An empty folder counts for pi, but nothing is lost when it is off.
function holds(path: string): boolean {
  try {
    return !statSync(path).isDirectory() || readdirSync(path).length > 0
  } catch {
    return false
  }
}

// The folder's .pi, and .agents/skills in it or any parent but the one in the home folder.
export function hasProjectFiles(folder: string, env: Record<string, string | undefined>): boolean {
  if (PI_FILES.some((name) => holds(join(folder, ".pi", name)))) return true
  const userSkills = join(canonical(env["HOME"] || homedir()), ".agents", "skills")
  for (let at = folder; ; at = dirname(at)) {
    const skills = join(at, ".agents", "skills")
    if (skills !== userSkills && holds(skills)) return true
    if (dirname(at) === at) return false
  }
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return null
    const json = parseJson(readFileSync(path, "utf8").replace(/^﻿/, ""))
    return json.ok ? json.value : null
  } catch {
    return null
  }
}

const decisions = z.record(z.string(), z.unknown())
const globalSettings = z.looseObject({ defaultProjectTrust: z.unknown() })

// The nearest saved decision for the folder or a parent; null when none was saved.
function savedDecision(folder: string, agent: string): boolean | null {
  const parsed = decisions.safeParse(readJson(join(agent, "trust.json")))
  if (!parsed.success) return null
  for (let at = folder; ; at = dirname(at)) {
    const value = parsed.data[at]
    if (value === true || value === false) return value
    if (dirname(at) === at) return null
  }
}

// The canonical folder whose project files pi leaves off and whose user never decided about it; null otherwise.
// "never" for every project is a decision too.
export function untrustedFolder(cwd: string, env: Record<string, string | undefined>): string | null {
  const folder = canonical(cwd)
  if (!hasProjectFiles(folder, env)) return null
  const agent = agentDir(env)
  if (savedDecision(folder, agent) !== null) return null
  const settings = globalSettings.safeParse(readJson(join(agent, "settings.json")))
  const every = settings.success ? settings.data.defaultProjectTrust : undefined
  return every === "always" || every === "never" ? null : folder
}
