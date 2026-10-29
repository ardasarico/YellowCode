// Raw steps over any Transport: the recorder runs them on a live app-server, tests run them on a replay.
import { follow } from "../opencode/driver.ts"
import { rpcClient, type Incoming, type RpcId, type Transport } from "../../src/agents/codex/transport.ts"

export { pick, text } from "../opencode/driver.ts"

export type Driver = {
  // The project folder threads start in; a fixture has it as <root>/project.
  directory: string
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): void
  // The next notification or server request of `method` (that `match` accepts) after the last one an `until`
  // returned, already arrived or not.
  until(method: string, match?: (message: Incoming) => boolean, timeoutMs?: number): Promise<Incoming>
  respond(id: RpcId, result: unknown): void
  // Gives the live app-server time where no message says it is done. A replay does not wait.
  pause(ms: number): Promise<void>
  close(): Promise<void>
}

export type DriverOptions = {
  directory: string
  onIntent?: (intent: string, args: unknown) => void
  timeoutMs?: number
  live?: boolean
}

export const CLIENT_INFO = { name: "yellowcode", title: "YellowCode", version: "0.0.0-recording" }

export function createDriver(transport: Transport, options: DriverOptions): Driver {
  const rpc = rpcClient(transport)
  const incoming = follow(rpc.incoming, (message) => message, "app-server")
  const timeout = options.timeoutMs ?? 30_000
  return {
    directory: options.directory,
    request(method, params) {
      options.onIntent?.("request", { method, ...(params === undefined ? {} : { params }) })
      return rpc.request(method, params)
    },
    notify(method, params) {
      options.onIntent?.("notify", { method, ...(params === undefined ? {} : { params }) })
      rpc.notify(method, params)
    },
    until(method, match, timeoutMs = timeout) {
      options.onIntent?.("until", { method })
      return incoming.until(method, (message) => message.method === method && (match?.(message) ?? true), timeoutMs)
    },
    respond(id, result) {
      options.onIntent?.("respond", { id, result })
      rpc.respond(id, result)
    },
    pause: (ms) => (options.live ? Bun.sleep(ms) : Promise.resolve()),
    close: () => rpc.close(),
  }
}

// The handshake every scenario starts with.
export async function initialize(d: Driver): Promise<unknown> {
  const reply = await d.request("initialize", {
    clientInfo: CLIENT_INFO,
    capabilities: { experimentalApi: true, requestAttestation: false },
  })
  d.notify("initialized")
  return reply
}
