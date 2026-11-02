// Pi's session files, read only: one JSON line per entry, a header first. Pi has no list command over RPC, so the
// folder it keeps a project's sessions in is worked out the way pi does it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import type { SessionEntry } from "../../agent/sessions.ts"
import { parseJson } from "../../json.ts"
import { withoutHandoff } from "../../session/handoff.ts"
import { oneLine } from "../../session/tool-summary.ts"
import { PI } from "./caps.ts"
import { textOf } from "./tools.ts"

export const agentDir = (env: Record<string, string | undefined> = process.env) =>
  env["PI_CODING_AGENT_DIR"] || join(homedir(), ".pi", "agent")

// Only `sessionDir` is read from pi's settings.
const piSettings = z.looseObject({ sessionDir: z.string().optional() })

function settingsDir(agent: string): string | null {
  try {
    const json = parseJson(readFileSync(join(agent, "settings.json"), "utf8"))
    const parsed = json.ok ? piSettings.safeParse(json.value) : null
    return parsed?.success ? (parsed.data.sessionDir ?? null) : null
  } catch {
    return null
  }
}

// The folder a project's sessions are in; `shared` when other projects' sessions are in it too.
export function sessionsDir(cwd: string, env: Record<string, string | undefined> = process.env) {
  const agent = agentDir(env)
  const own = env["PI_CODING_AGENT_SESSION_DIR"] || settingsDir(agent)
  if (own) return { dir: own, shared: true }
  const safe = `--${resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-")}--`
  return { dir: join(agent, "sessions", safe), shared: false }
}

const header = z.looseObject({
  type: z.literal("session"),
  id: z.string(),
  cwd: z.string().optional(),
  timestamp: z.string().optional(),
  parentSession: z.string().optional(),
})
const entry = z.looseObject({ type: z.string(), id: z.string().optional(), parentId: z.string().nullable().optional() })
export type Entry = z.output<typeof entry> & Record<string, unknown>
export type SessionFile = { id: string; cwd: string; parent: string | null; entries: Entry[] }

export function readSession(path: string): SessionFile | null {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return null
  }
  const rows = text.split("\n").flatMap((row) => {
    if (row.trim() === "") return []
    const json = parseJson(row)
    return json.ok ? [json.value] : []
  })
  const head = header.safeParse(rows[0])
  if (!head.success) return null
  const entries = rows.slice(1).flatMap((row) => {
    const parsed = entry.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
  return { id: head.data.id, cwd: head.data.cwd ?? "", parent: head.data.parentSession ?? null, entries }
}

// The entries of the branch the session is on: from its last entry back to the first.
export function branchOf(entries: Entry[]): Entry[] {
  const byId = new Map(entries.flatMap((one) => (one.id ? [[one.id, one] as const] : [])))
  const path: Entry[] = []
  let at = entries.findLast((one) => one.id !== undefined)
  const seen = new Set<string>()
  while (at?.id && !seen.has(at.id)) {
    seen.add(at.id)
    path.push(at)
    at = at.parentId ? byId.get(at.parentId) : undefined
  }
  return path.toReversed()
}

const message = z.looseObject({ role: z.string(), content: z.unknown().optional() })
const named = z.looseObject({ name: z.string() })
const modelChange = z.looseObject({ provider: z.string(), modelId: z.string() })

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content
  const parts = z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).safeParse(content)
  return parts.success ? textOf(parts.data) : ""
}

export function entryOf(file: SessionFile, modified: number): SessionEntry {
  const branch = branchOf(file.entries)
  const first = branch.find((one) => one.type === "message" && message.safeParse(one["message"]).data?.role === "user")
  const name = file.entries.findLast((one) => one.type === "session_info" && named.safeParse(one).success)
  const model = file.entries.findLast((one) => one.type === "model_change" && modelChange.safeParse(one).success)
  const change = model ? modelChange.parse(model) : null
  const firstPrompt = first ? withoutHandoff(textOfContent(message.parse(first["message"]).content)) : ""
  return {
    ref: { agent: PI, id: file.id },
    title: oneLine(name ? named.parse(name).name : "") || oneLine(firstPrompt),
    firstPrompt,
    cwd: file.cwd,
    branch: null,
    model: change ? { provider: change.provider, id: change.modelId } : null,
    modified,
  }
}

const sessionFiles = (dir: string) => {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
  } catch {
    return []
  }
}

// Every session of the folder that has a prompt, newest first.
export function listSessions(cwd: string, env: Record<string, string | undefined> = process.env): SessionEntry[] {
  const { dir, shared } = sessionsDir(cwd, env)
  if (!existsSync(dir)) return []
  return sessionFiles(dir)
    .flatMap((name) => {
      const path = join(dir, name)
      const file = readSession(path)
      if (!file || (shared && resolve(file.cwd) !== resolve(cwd))) return []
      const listed = entryOf(file, statSync(path).mtimeMs)
      return listed.firstPrompt === "" ? [] : [listed]
    })
    .toSorted((a, b) => b.modified - a.modified)
}

// The file of a session, by the id its name ends with.
export function sessionPath(
  cwd: string,
  id: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const { dir } = sessionsDir(cwd, env)
  const name = sessionFiles(dir).find((one) => one.endsWith(`_${id}.jsonl`))
  return name ? join(dir, name) : null
}

// The file of a session in any project's folder, for reading it by id alone.
export function findSession(id: string, env: Record<string, string | undefined> = process.env): string | null {
  const agent = agentDir(env)
  const own = env["PI_CODING_AGENT_SESSION_DIR"] || settingsDir(agent)
  const root = join(agent, "sessions")
  let dirs: string[] = own ? [own] : []
  try {
    dirs = [...dirs, ...readdirSync(root).map((name) => join(root, name))]
  } catch {
    // No sessions yet.
  }
  for (const dir of dirs) {
    const name = sessionFiles(dir).find((one) => one.endsWith(`_${id}.jsonl`))
    if (name) return join(dir, name)
  }
  return null
}
