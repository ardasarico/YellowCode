// Starts a private opencode service in an isolated root, the way the adapter connects (`ensure` from
// @opencode/client/service), and proves it never meets the user's own service or files.
// Usage: bun tools/opencode/service.ts --smoke [--keep]
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { ensure, fallback } from "@opencode/client/service"
import { httpTransport, type Endpoint, type Transport } from "../../src/agents/opencode/transport.ts"
import { createDriver, pick, text } from "./driver.ts"
import { makeRoot, serviceEnv, withServiceEnv, writeConfig, type Root } from "./env.ts"
import { startMock } from "./mock.ts"
import { TMP } from "../tmp.ts"

export const BINARY = join(homedir(), ".opencode", "bin", "opencode")
// The user's own registration, from the real env. The isolated run must never use this path.
const USER_REGISTRATION = fallback()
const HOME = homedir()

export type Running = {
  root: Root
  endpoint: Endpoint
  pid: number
  password: string
  transport(): Transport
  // Stops our processes, checks the user's service and registration are as before, and removes the root.
  stop(): Promise<string[]>
}

// The user's registration holds their password, so the harness only stats it. The adapter, which reads a
// registration's pid and url, sees only the isolated one here.
function snapshot(file: string): string {
  if (!existsSync(file)) return "missing"
  const { size, mtimeMs, ino } = statSync(file)
  return `${size} ${mtimeMs} ${ino}`
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

const isService = (command: string) => command.includes("opencode") && command.includes(" serve")

// Reads one process's env, only to see whether it runs in the root.
// Looks in the process's command line and environment: ps -E shows both on macOS, Linux keeps them in /proc.
function runsIn(pid: number, root: string): boolean {
  if (process.platform === "darwin") return run("ps", ["-Eww", "-o", "command=", "-p", String(pid)]).includes(root)
  try {
    return ["cmdline", "environ"].some((file) => readFileSync(`/proc/${pid}/${file}`, "utf8").includes(root))
  } catch {
    return false
  }
}

// Opencode services that are not ours, by pid. Only their command lines are read.
function userServices(root: string): number[] {
  return table()
    .filter((row) => isService(row.command) && !row.command.includes(root))
    .map((row) => row.pid)
}

// Finds our processes: those whose command line names the root, opencode services (not the user's) whose env names
// it, earlier finds (orphans), and the descendants of all of them. Env is read once per candidate, never for the whole
// machine, and the watch calls this often, so it stays cheap.
function finder(root: string, theirs: number[]): () => number[] {
  const seen = new Set<number>()
  const inRoot = new Map<number, boolean>()
  const runsInRoot = (pid: number) => {
    if (!inRoot.has(pid)) inRoot.set(pid, runsIn(pid, root))
    return inRoot.get(pid) === true
  }
  return () => {
    const rows = table().filter((row) => row.pid !== process.pid && !theirs.includes(row.pid))
    const found = new Set<number>()
    for (const row of rows) {
      const candidate = row.command.includes(root) || seen.has(row.pid) || isService(row.command)
      if (candidate && (row.command.includes(root) || runsInRoot(row.pid))) found.add(row.pid)
    }
    for (let size = -1; size !== found.size;) {
      size = found.size
      for (const row of rows) if (found.has(row.ppid)) found.add(row.pid)
    }
    for (const pid of found) seen.add(pid)
    return [...found]
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const listener = (port: string) =>
  run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
    .trim()
    .split("\n")

const LOOPBACK = /(?:127\.0\.0\.1|\[::1\]|localhost|\*):\d+/g

// One look at what our processes hold open: a socket to anything but loopback, or a file under the real home other
// than the opencode binary itself, is a problem.
function look(ours: () => number[], problems: Set<string>): void {
  const pids = ours()
  if (pids.length === 0) return
  const rows = run("lsof", ["-nP", "-p", pids.join(","), "-F", "ftn"]).split("\n")
  let type = ""
  for (const row of rows) {
    if (row.startsWith("t")) type = row.slice(1)
    if (!row.startsWith("n")) continue
    const name = row.slice(1)
    if (type.startsWith("IPv") && name.replaceAll(LOOPBACK, "").replace("->", "").trim() !== "") {
      problems.add(`socket ${name}`)
    }
    if (
      (type === "REG" || type === "DIR") &&
      name.startsWith(HOME + "/") &&
      !name.startsWith(join(HOME, ".opencode", "bin"))
    ) {
      problems.add(`file ${name}`)
    }
  }
}

// Our own registration: the pid to watch and stop, and the url `ensure` should have returned.
function registrationOf(file: string): { pid: number; url: string } {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"))
  const pid = pick(value, "pid")
  const url = pick(value, "url")
  return { pid: typeof pid === "number" ? pid : -1, url: typeof url === "string" ? url : "" }
}

// With `keep`, the root stays on disk after stop or a failed start.
export async function startService(root: Root, options: { keep?: boolean } = {}): Promise<Running> {
  if (root.registration === USER_REGISTRATION) throw new Error("the isolated registration is the user's own")
  if (!root.root.startsWith(`${TMP}/yc-oc-`)) throw new Error(`unexpected root ${root.root}`)
  const before = snapshot(USER_REGISTRATION)
  const theirs = userServices(root.root)
  const ours = finder(root.root, theirs)

  // Stops our processes and removes the root; returns what is still running.
  const teardown = async (): Promise<string[]> => {
    const left = await kill(ours)
    if (!options.keep) await rm(root.root, { recursive: true, force: true })
    return left.length > 0 ? [`processes ${left.join(", ")} in ${root.root} are still running`] : []
  }
  const fail = async (message: string, cause?: unknown): Promise<never> => {
    throw new Error([message, ...(await teardown())].join("; "), { cause })
  }

  const cwd = process.cwd()
  // The service inherits the cwd; it should sit in the root, not in the repo.
  process.chdir(root.home)
  const endpoint = await withServiceEnv(() =>
    ensure({
      file: root.registration,
      command: [BINARY, "serve", "--service"],
      env: serviceEnv(root),
      version: () => true,
    }),
  )
    .finally(() => process.chdir(cwd))
    .catch((error: unknown) => fail(`ensure: ${error instanceof Error ? error.message : String(error)}`, error))

  const { pid, url } = registrationOf(root.registration)
  const port = new URL(endpoint.url).port
  const problems = new Set<string>()
  if (url !== endpoint.url) problems.add("the endpoint is not the isolated registration's")
  if (theirs.includes(pid)) problems.add("the endpoint belongs to the user's service")
  else if (!runsIn(pid, `XDG_STATE_HOME=${root.state}`)) problems.add(`pid ${pid} does not run in the isolated root`)
  if (!listener(port).includes(String(pid))) problems.add(`port ${port} is not held by pid ${pid}`)
  if (problems.size > 0) await fail(`isolation: ${[...problems].join("; ")}`)

  const watch = setInterval(() => look(ours, problems), 300)
  look(ours, problems)

  return {
    root,
    endpoint,
    pid,
    password: endpoint.auth?.password ?? "",
    transport: () => httpTransport(endpoint, root.project),
    async stop() {
      clearInterval(watch)
      look(ours, problems)
      for (const problem of await teardown()) problems.add(problem)
      if (snapshot(USER_REGISTRATION) !== before) problems.add("the user's registration file changed")
      for (const other of theirs) if (!alive(other)) problems.add(`the user's service ${other} is gone`)
      return [...problems]
    },
  }
}

// Returns the pids that outlived SIGTERM and SIGKILL.
async function kill(ours: () => number[]): Promise<number[]> {
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

async function smoke(keep: boolean): Promise<void> {
  const root = await makeRoot("smoke")
  const script = { threads: [{ match: "SMOKE", steps: [[{ type: "text" as const, text: "Smoke answer." }]] }] }
  const mock = startMock(script, join(root.root, "bodies.jsonl"))
  await writeConfig(root, mock.baseURL)
  const service = await startService(root, { keep })
  const problems: string[] = []
  try {
    const d = createDriver(service.transport(), { directory: root.project })
    const version = pick(await d.http("GET", "/api/info"), "body", "version")
    console.log(`GET /api/info version ${String(version)}`)
    if (version !== "2.2.0") problems.push(`version ${String(version)}`)
    const unauthorized = await fetch(new URL("/api/info", service.endpoint.url))
    if (unauthorized.status !== 401) problems.push(`no auth answered ${unauthorized.status}`)
    const id = text(
      await d.http("POST", "/api/session", { location: { directory: root.project } }),
      "body",
      "data",
      "id",
    )
    await d.http("POST", `/api/session/${id}/prompt`, { text: "SMOKE hi" })
    await d.until("session.execution.succeeded")
    d.close()
    const bodies = readFileSync(join(root.root, "bodies.jsonl"), "utf8").trim().split("\n")
    console.log(`mock got ${bodies.length} request(s)`)
    if (!bodies.some((body) => body.includes("SMOKE hi"))) problems.push("the mock never got the prompt")
  } finally {
    problems.push(...(await service.stop()))
    await mock.stop()
  }
  if (problems.length > 0) throw new Error(`smoke: ${problems.join("; ")}`)
  console.log(
    `smoke ok: pid ${service.pid} stopped, the user's registration and service as before, no outside socket or file`,
  )
}

if (import.meta.main) {
  if (!process.argv.includes("--smoke")) throw new Error("usage: bun tools/opencode/service.ts --smoke [--keep]")
  await smoke(process.argv.includes("--keep"))
}
