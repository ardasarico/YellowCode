// Starts `codex app-server` in an isolated root and proves it never touches the user's Codex home or the network.
import { spawnSync } from "node:child_process"
import { existsSync, realpathSync, statSync } from "node:fs"
import { appendFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Socket } from "bun"
import { stdioTransport, type Transport } from "../../src/agents/codex/transport.ts"
import { serverEnv, type Root } from "./env.ts"

const USER_HOME = join(homedir(), ".codex")
const WATCHED = [USER_HOME, join(USER_HOME, "config.toml")]

export type Running = {
  transport: Transport
  pid: number
  // Stops our processes, checks the user's Codex home is as before and nothing left the machine, and removes the
  // root (unless kept). Returns the problems found.
  stop(): Promise<string[]>
}

// mtime only: the user's files are never read.
export function snapshot(file: string): string {
  if (!existsSync(file)) return "missing"
  const { mtimeMs, ino } = statSync(file)
  return `${mtimeMs} ${ino}`
}

function run(command: string, args: string[]): string {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? ""
}

type Row = { pid: number; ppid: number; command: string }

function table(): Row[] {
  return run("ps", ["-axww", "-o", "pid=,ppid=,command="])
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }] : []
    })
}

// Our app-server, its descendants, anything whose command line names the root, and earlier finds (orphans).
export function finder(pid: number, root: string): () => number[] {
  const seen = new Set<number>([pid])
  return () => {
    const rows = table().filter((row) => row.pid !== process.pid)
    const found = new Set(rows.filter((row) => seen.has(row.pid) || row.command.includes(root)).map((row) => row.pid))
    for (let size = -1; size !== found.size;) {
      size = found.size
      for (const row of rows) if (found.has(row.ppid)) found.add(row.pid)
    }
    for (const one of found) seen.add(one)
    return [...found]
  }
}

const LOOPBACK = /(?:127\.0\.0\.1|\[::1\]|localhost|\*):\d+/g

// One look at what our processes hold open: a socket to anything but loopback is a problem.
export function look(ours: () => number[], problems: Set<string>): void {
  const pids = ours()
  if (pids.length === 0) return
  const rows = run("lsof", ["-nP", "-a", "-i", "-p", pids.join(","), "-F", "n"]).split("\n")
  for (const row of rows) {
    if (!row.startsWith("n")) continue
    const name = row.slice(1)
    if (name.replaceAll(LOOPBACK, "").replace("->", "").trim() !== "") problems.add(`socket ${name}`)
  }
}

// Returns the pids that outlived SIGTERM and SIGKILL.
export async function kill(ours: () => number[]): Promise<number[]> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const pids = ours()
    if (pids.length === 0) return []
    for (const pid of pids) {
      try {
        process.kill(pid, signal)
      } catch {
        // Already gone.
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- polls until the processes are gone
    for (let wait = 0; wait < 50 && ours().length > 0; wait++) await Bun.sleep(100)
  }
  return ours()
}

// A proxy that writes where each outbound request wanted to go to `log` and refuses it.
export function startBlocker(log: string): { url: string; stop(): void } {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket: Socket, data) {
        const first = data.toString("utf8").split("\r\n")[0] ?? ""
        void appendFile(log, `${first}\n`)
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
      },
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

export function startServer(root: Root, proxy: string, options: { keep?: boolean } = {}): Running {
  if (!root.root.startsWith("/private/tmp/yc-cx-")) throw new Error(`unexpected root ${root.root}`)
  if (existsSync(USER_HOME) && realpathSync(root.codex) === realpathSync(USER_HOME))
    throw new Error("the isolated CODEX_HOME is the user's own")
  const before = WATCHED.map(snapshot)
  const stderr = join(root.root, "stderr.log")
  const transport = stdioTransport({
    command: ["codex", "app-server"],
    cwd: root.project,
    env: serverEnv(root, proxy),
    onStderr: (text) => void appendFile(stderr, text),
  })
  const ours = finder(transport.pid, root.root)
  const problems = new Set<string>()
  const watch = setInterval(() => look(ours, problems), 300)

  return {
    transport,
    pid: transport.pid,
    async stop() {
      clearInterval(watch)
      look(ours, problems)
      await transport.close()
      const left = await kill(ours)
      if (left.length > 0) problems.add(`processes ${left.join(", ")} in ${root.root} are still running`)
      if (WATCHED.map(snapshot).join() !== before.join()) problems.add("the user's ~/.codex changed")
      if (!options.keep) await rm(root.root, { recursive: true, force: true })
      return [...problems]
    },
  }
}
