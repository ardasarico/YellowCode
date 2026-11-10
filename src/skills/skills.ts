// YellowCode's own skills, written as one folder in Claude Code's plugin layout: `.claude-plugin/plugin.json` and
// `skills/<name>/SKILL.md`. Each agent gets the folder its own way (StartOptions.skills).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { appVersion } from "../build-info.ts"
import { log } from "../log/log.ts"
import { yellowcodeHome } from "../update/method.ts"
import { skillFiles } from "./embed.ts"

declare const SKILL_FILES: Record<string, string>

const ownFiles = (): Record<string, string> =>
  typeof SKILL_FILES === "object" ? SKILL_FILES : skillFiles(join(import.meta.dir, "..", ".."))

function filesIn(path: string): string[] {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(path, entry.name)) : [join(path, entry.name)],
  )
}

function writeIfChanged(path: string, text: string): void {
  let now: string | null = null
  try {
    now = readFileSync(path, "utf8")
  } catch {
    // Not written yet.
  }
  if (now === text) return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, path)
}

// Writes this version's skills into `folder`, leaving files of no skill out; null when they cannot be written.
export function writeSkills(folder: string): string | null {
  try {
    const plugin = { name: "yellowcode", version: appVersion, description: "YellowCode's docs and mod guide." }
    const files = { ...ownFiles(), ".claude-plugin/plugin.json": `${JSON.stringify(plugin, null, 2)}\n` }
    for (const [path, text] of Object.entries(files)) writeIfChanged(join(folder, path), text)
    // Another YellowCode may be writing its own temp files here at the same time.
    for (const path of filesIn(folder))
      if (!path.endsWith(".tmp") && !Object.hasOwn(files, relative(folder, path))) rmSync(path, { force: true })
    return folder
  } catch (error) {
    log.warn("YellowCode's skills could not be written", error)
    return null
  }
}

let written: string[] | null = null

// The skills folders every session gets; empty when ours could not be written.
export function builtInSkills(): string[] {
  if (written) return written
  const folder = writeSkills(join(yellowcodeHome(), "skills"))
  written = folder ? [folder] : []
  return written
}

const field = (text: string, name: string) => text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim()

// The skills of these folders as text, for an agent that takes no skills folder: each one's SKILL.md to read.
export function skillsAsText(folders: readonly string[]): string | null {
  const lines = folders.flatMap((folder) => {
    const skills = join(folder, "skills")
    if (!existsSync(skills)) return []
    return readdirSync(skills).flatMap((name) => {
      const path = join(skills, name, "SKILL.md")
      if (!existsSync(path)) return []
      const text = readFileSync(path, "utf8")
      return [`- ${field(text, "name") ?? name}: ${field(text, "description") ?? ""} (${path})`]
    })
  })
  if (lines.length === 0) return null
  return [
    "Skills you have: when a task matches one, read its SKILL.md with your read tool and follow it; the files it names sit next to it.",
    ...lines,
  ].join("\n")
}
