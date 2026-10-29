// Finds opencode's one shared local service the way its own TUI does, through @opencode/client/service: the
// registered service when it answers, else a new `opencode serve --service`, which keeps running after YellowCode
// quits. The user's service is never stopped or restarted. `stop` is not imported here or anywhere else.
import { readFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { discover, ensure, fallback } from "@opencode/client/service"
import { z } from "zod"
import { parseJson } from "../../json.ts"
import { log } from "../../log/log.ts"
import type { Endpoint } from "./transport.ts"

export type ServiceClient = { discover: typeof discover; ensure: typeof ensure }

const WAIT_MS = 10_000
const POLL_MS = 250
const CONNECT_MS = 1_000
const LOOPBACK = ["127.0.0.1", "localhost", "::1"]

// Any version: a version that differs is no reason to restart the user's service.
const anyVersion = () => true

// The registration also holds the service's password; only its pid and url are kept.
const registered = z.object({ pid: z.number(), url: z.string() })

async function registration(file: string): Promise<z.output<typeof registered> | null> {
  const text = await readFile(file, "utf8").catch(() => null)
  if (text === null) return null
  const json = parseJson(text)
  const parsed = json.ok ? registered.safeParse(json.value) : null
  return parsed?.success ? parsed.data : null
}

// Only a process of this user can be the user's service; a pid another user holds now was reused.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// False only when nothing listens at the url: a connect that hangs counts as a service that is busy.
function listening(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname.replace(/^\[|\]$/g, ""), port: Number(port) })
    const done = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(CONNECT_MS, () => done(true))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

// `ensure` stops a registered service it cannot use: after three health checks that time out, or when it answers
// with no version. Both need a live process that listens at the registered url, so with one, `ensure` is not called.
async function held(file: string): Promise<boolean> {
  const found = await registration(file).catch(() => null)
  return found !== null && alive(found.pid) && (await listening(found.url).catch(() => false))
}

// The client checks the service with fetch, and Bun's fetch sends even loopback requests through HTTP_PROXY, with the
// password in the header. For the call only, loopback is added to NO_PROXY; the env is put back afterwards. A service
// started meanwhile gets the user's own values (empty when unset, which proxies read the same way).
async function withoutLoopbackProxy<T>(run: (userEnv: Record<string, string>) => Promise<T>): Promise<T> {
  const saved = { NO_PROXY: process.env["NO_PROXY"], no_proxy: process.env["no_proxy"] }
  const current = saved.NO_PROXY ?? saved.no_proxy ?? ""
  const value = [...current.split(",").filter((host) => host.trim() !== ""), ...LOOPBACK].join(",")
  process.env["NO_PROXY"] = value
  process.env["no_proxy"] = value
  try {
    return await run({ NO_PROXY: saved.NO_PROXY ?? "", no_proxy: saved.no_proxy ?? "" })
  } finally {
    for (const [key, before] of Object.entries(saved)) {
      if (before === undefined) delete process.env[key]
      else process.env[key] = before
    }
  }
}

const refuseReplace = (reason: "missing" | "version-mismatch") => {
  // `ensure` would stop the registered service to start another one.
  if (reason === "version-mismatch") throw new Error("opencode's service runs a version this client would replace")
}

// The service's endpoint. While a registered service may be the user's, `ensure` is not called (see `held`); one that
// is starting gets time to answer instead. This narrows, not closes, the case: a service that registers while our
// `ensure` runs and then misses three health checks is still stopped by it, as opencode's own clients would.
export async function findService(
  binary: string,
  client: ServiceClient = { discover, ensure },
  wait = { totalMs: WAIT_MS, pollMs: POLL_MS },
): Promise<Endpoint> {
  return withoutLoopbackProxy(async (userEnv) => {
    const found = await client.discover({ version: anyVersion })
    if (found) return found
    if (await held(fallback())) {
      const until = Date.now() + wait.totalMs
      while (Date.now() < until) {
        // oxlint-disable-next-line no-await-in-loop -- polls a service that is starting
        await Bun.sleep(wait.pollMs)
        // oxlint-disable-next-line no-await-in-loop -- polls a service that is starting
        const later = await client.discover({ version: anyVersion })
        if (later) return later
      }
      log.warn("opencode: the registered service does not answer")
      throw new Error("opencode's registered service does not answer")
    }
    // The client's error may end with the service's own output, which is never passed on.
    return client
      .ensure({ command: [binary, "serve", "--service"], version: anyVersion, onStart: refuseReplace, env: userEnv })
      .catch(() => {
        log.warn("opencode: the service did not start")
        throw new Error("opencode's service did not start")
      })
  })
}
