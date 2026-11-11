import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { log } from "../log/log.ts"
import { memoryRoot } from "../paths.ts"
import { projectOf } from "../peers/project.ts"
import { projectKey } from "../project-key.ts"
import { gitEnv } from "../rewind/common.ts"

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

// `name` is the file's name without `.md`.
export type Memory = { name: string; description: string; type: MemoryType; body: string; modified: number }

export type Saved = { ok: true; replaced: boolean; count: number } | { ok: false; problem: string }

// The list goes into every session, one line per memory.
export const MAX_MEMORIES = 200
export const NEAR_FULL = 160
const MAX_DESCRIPTION = 200
const MAX_BODY = 16 * 1024
const INDEX = "MEMORY.md"
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_\w{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
]

// The repository a folder belongs to, the same for every worktree of it; the folder's own project outside git.
export function memoryProject(cwd: string): string {
  try {
    const run = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      env: gitEnv({}),
      stderr: "ignore",
    })
    const common = run.exitCode === 0 ? run.stdout.toString().trim() : ""
    if (basename(common) === ".git") return realpathSync(dirname(common))
  } catch {
    // Not a repository git can read.
  }
  return projectOf(cwd)
}

export const memoryFolder = (cwd: string, root = memoryRoot()): string => join(root, projectKey(memoryProject(cwd)))

const fileOf = (folder: string, name: string) => join(folder, `${name}.md`)

function parse(name: string, text: string, modified: number): Memory {
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text)
  let front: unknown = {}
  try {
    front = match?.[1]?.trim() ? Bun.YAML.parse(match[1]) : {}
  } catch {
    // A file with broken frontmatter still shows, by its name.
  }
  const fields = new Map<string, unknown>(typeof front === "object" && front !== null ? Object.entries(front) : [])
  const metadata = fields.get("metadata")
  const kind =
    typeof metadata === "object" && metadata !== null && "type" in metadata ? metadata.type : fields.get("type")
  const description = fields.get("description")
  return {
    name,
    description: typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "",
    type: MEMORY_TYPES.find((type) => type === kind) ?? "project",
    body: (match ? (match[2] ?? "") : text).trim(),
    modified,
  }
}

export function readMemory(folder: string, name: string): Memory | null {
  if (!NAME.test(name)) return null
  try {
    const path = fileOf(folder, name)
    return parse(name, readFileSync(path, "utf8"), statSync(path).mtimeMs)
  } catch {
    return null
  }
}

export function listMemories(folder: string): Memory[] {
  let files: string[]
  try {
    files = readdirSync(folder)
  } catch {
    return []
  }
  return files
    .filter((file) => file.endsWith(".md") && file !== INDEX)
    .map((file) => readMemory(folder, basename(file, ".md")))
    .filter((memory) => memory !== null)
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

export const indexLine = (memory: Memory) => `- ${memory.name} (${memory.type}): ${memory.description}`

function write(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, path)
}

// The folder's own list, for whoever opens it; sessions get theirs from the files.
export function writeIndex(folder: string): void {
  try {
    write(join(folder, INDEX), `${listMemories(folder).map(indexLine).join("\n")}\n`)
  } catch (error) {
    log.warn("memory index not written", error)
  }
}

const fileText = (memory: Omit<Memory, "modified">) =>
  [
    "---",
    `name: ${memory.name}`,
    `description: ${JSON.stringify(memory.description)}`,
    "metadata:",
    `  type: ${memory.type}`,
    "---",
    "",
    memory.body,
    "",
  ].join("\n")

export function saveMemory(folder: string, input: Omit<Memory, "modified">): Saved {
  const description = input.description.replace(/\s+/g, " ").trim()
  const body = input.body.trim()
  if (!NAME.test(input.name) || input.name === "memory")
    return { ok: false, problem: "The name must be short kebab-case: lowercase letters, digits and dashes." }
  if (description === "") return { ok: false, problem: "The description is empty." }
  if (description.length > MAX_DESCRIPTION)
    return { ok: false, problem: `The description is over ${MAX_DESCRIPTION} characters; keep it to one line.` }
  if (body === "") return { ok: false, problem: "The body is empty." }
  if (body.length > MAX_BODY) return { ok: false, problem: "The body is too long; keep one fact to a memory." }
  if (SECRETS.some((pattern) => pattern.test(body) || pattern.test(description)))
    return { ok: false, problem: "This looks like it holds a credential. Leave the secret out and save the rest." }
  const names = listMemories(folder).map((memory) => memory.name)
  const replaced = names.includes(input.name)
  if (!replaced && names.length >= MAX_MEMORIES)
    return {
      ok: false,
      problem: `The memory is full (${MAX_MEMORIES}). Update a memory that covers this, or forget one first.`,
    }
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    write(fileOf(folder, input.name), fileText({ ...input, description, body }))
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) }
  }
  writeIndex(folder)
  return { ok: true, replaced, count: names.length + (replaced ? 0 : 1) }
}

// A memory file from elsewhere, taken as it is. False for one that cannot come in: a name of another form or already
// taken, a full memory, or text that looks like it holds a credential. The caller writes the index.
export function copyMemory(folder: string, name: string, text: string): boolean {
  if (!NAME.test(name) || name === "memory" || SECRETS.some((pattern) => pattern.test(text))) return false
  const names = listMemories(folder).map((memory) => memory.name)
  if (names.includes(name) || names.length >= MAX_MEMORIES) return false
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  write(fileOf(folder, name), text)
  return true
}

export function forgetMemory(folder: string, name: string): boolean {
  if (!readMemory(folder, name)) return false
  rmSync(fileOf(folder, name), { force: true })
  writeIndex(folder)
  return true
}
