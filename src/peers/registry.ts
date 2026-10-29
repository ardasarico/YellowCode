import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { parseJson } from "../json.ts"
import { alive, writeJson } from "../rewind/common.ts"

const RECORD = z.object({
  pid: z.number().int(),
  session: z.string().nullable(),
  agent: z.string(),
  title: z.string(),
  cwd: z.string(),
  // The folder that decides which sessions share a project, see projectOf.
  project: z.string(),
  model: z.string(),
  status: z.enum(["busy", "idle"]),
  hidden: z.boolean(),
  socket: z.string(),
})

export type PeerRecord = z.infer<typeof RECORD>
export type PeerState = Omit<PeerRecord, "pid" | "socket">
export type Registry = { readonly socket: string; update(patch: Partial<PeerState>): void; remove(): void }

export const defaultPeersDir = () =>
  process.env["YELLOWCODE_SESSIONS_DIR"] ?? join(homedir(), ".yellowcode", "sessions")

// Only this user may read the records or reach the sockets.
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

function removeFiles(dir: string, pid: number): void {
  rmSync(join(dir, `${pid}.json`), { force: true })
  rmSync(join(dir, `${pid}.sock`), { force: true })
}

export function openRegistry(start: PeerState, dir = defaultPeersDir()): Registry {
  ensureDir(dir)
  const pid = process.pid
  const socket = join(dir, `${pid}.sock`)
  let record: PeerRecord = { ...start, pid, socket }
  writeJson(join(dir, `${pid}.json`), record)
  return {
    socket,
    update(patch) {
      record = { ...record, ...patch }
      writeJson(join(dir, `${pid}.json`), record)
    },
    remove: () => removeFiles(dir, pid),
  }
}

// Every live record. A record whose process is gone is deleted on the way.
export function listPeers(dir = defaultPeersDir()): PeerRecord[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch {
    return []
  }
  return names.flatMap((name) => {
    let text: string
    try {
      text = readFileSync(join(dir, name), "utf8")
    } catch {
      return []
    }
    const json = parseJson(text)
    const parsed = json.ok ? RECORD.safeParse(json.value) : null
    if (!parsed?.success) return []
    if (alive(parsed.data.pid)) return [parsed.data]
    removeFiles(dir, parsed.data.pid)
    return []
  })
}
