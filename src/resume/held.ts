import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import { CLAUDE_PROJECTS } from "./project-key.ts"

// Claude Code lists each running claude in <pid>.json; the folder also holds key files, which are never opened.
const REGISTRY = join(dirname(CLAUDE_PROJECTS), "sessions")
const Running = z.looseObject({ pid: z.number(), sessionId: z.string() })

type Process = { pid: number; parent: number; args: string }

// Null when the list cannot be read.
async function processes(): Promise<Process[] | null> {
  try {
    const child = Bun.spawn(["ps", "-Aww", "-o", "pid=", "-o", "ppid=", "-o", "args="], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000,
    })
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (code !== 0) return null
    return text.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), args: match[3] ?? "" }] : []
    })
  } catch {
    return null
  }
}

// YellowCode itself and everything it started, its own claude processes among them.
function ours(all: Process[]): Set<number> {
  const own = new Set([process.pid])
  let grew = true
  while (grew) {
    grew = false
    for (const { pid, parent } of all) {
      if (own.has(parent) && !own.has(pid)) {
        own.add(pid)
        grew = true
      }
    }
  }
  return own
}

// A claude binary, started by name, by path, or as the script of node or bun; not any command that mentions it.
export function isClaude(args: string): boolean {
  return args
    .split(/\s+/)
    .slice(0, 2)
    .some((word) => /(^|\/)claude$/.test(word) || /\/claude(-code)?\//.test(word))
}

// The sessions a command line runs, in the forms claude takes: --resume <id>, --resume=<id>, -r <id>, -r<id>,
// --session-id <id>, --session-id=<id>. A fork runs its own --session-id, not the session it resumes.
export function sessionsIn(args: string): string[] {
  const words = args.split(/\s+/)
  const fork = words.includes("--fork-session")
  return words.flatMap((word, index) => {
    const next = words[index + 1] ?? ""
    if (word === "--session-id") return [next]
    if (word.startsWith("--session-id=")) return [word.slice("--session-id=".length)]
    if (fork) return []
    if (word === "--resume" || word === "-r") return [next]
    if (word.startsWith("--resume=")) return [word.slice("--resume=".length)]
    if (word.startsWith("-r") && !word.startsWith("-r=")) return [word.slice(2)]
    return []
  })
}

function registered(id: string): number[] {
  let names: string[]
  try {
    names = readdirSync(REGISTRY).filter((name) => /^\d+\.json$/.test(name))
  } catch {
    return []
  }
  return names.flatMap((name) => {
    let text = ""
    try {
      text = readFileSync(join(REGISTRY, name), "utf8")
    } catch {}
    const json = parseJson(text)
    const entry = json.ok ? Running.safeParse(json.value) : null
    return entry?.success && entry.data.sessionId === id ? [entry.data.pid] : []
  })
}

// Another process runs this session: a claude started for it (another YellowCode window, a --resume), or one Claude
// Code lists as running it (a session started in Claude Code itself). Without a process list it counts as held, so
// the session opens as a copy.
export async function heldElsewhere(id: string): Promise<boolean> {
  const all = await processes()
  if (all === null) {
    log.warn("cannot list processes; the session opens as a copy", { id })
    return true
  }
  const own = ours(all)
  const alive = new Set(all.map((entry) => entry.pid))
  const holder =
    all.find((entry) => !own.has(entry.pid) && isClaude(entry.args) && sessionsIn(entry.args).includes(id))?.pid ??
    registered(id).find((pid) => alive.has(pid) && !own.has(pid))
  if (holder !== undefined) log.info("session held elsewhere", { id, pid: holder })
  return holder !== undefined
}
