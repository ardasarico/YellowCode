// `codex app-server` speaks JSON-RPC 2.0 over stdio, one JSON object per line, without the "jsonrpc" field.
// A Transport moves whole messages (the stdio one, or a replay of a fixture); `rpcClient` pairs requests with their
// responses on top of it.
import { z } from "zod"
import { parseJson } from "../../json.ts"
import { log } from "../../log/log.ts"

export type Exit = { code: number | null; signal: string | null }

export type Transport = {
  // Each line of stdout as JSON (a line that is not JSON as a string). Ends when the process exits or `close` runs.
  messages: AsyncIterable<unknown>
  send(message: unknown): void
  exited: Promise<Exit>
  close(): Promise<void>
}

export type RpcId = number | string

export type Incoming =
  // `at` is when app-server sent it (`emittedAtMs`).
  | { type: "notification"; method: string; params: unknown; at: number | null }
  | { type: "request"; id: RpcId; method: string; params: unknown }

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message} (${code})`)
  }
}

export type Rpc = {
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): void
  respond(id: RpcId, result: unknown): void
  fail(id: RpcId, code: number, message: string): void
  // Notifications and server requests, in order. Ends when the transport does.
  incoming: AsyncIterable<Incoming>
  exited: Promise<Exit>
  close(): Promise<void>
}

const id = z.union([z.number(), z.string()])
const envelope = z.looseObject({
  id: id.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  emittedAtMs: z.number().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
})

export type Queue<T> = { push(item: T): void; end(): void; items: AsyncIterable<T> }

export function queue<T>(): Queue<T> {
  const items: T[] = []
  let ended = false
  let wake: (() => void) | null = null
  const notify = () => {
    wake?.()
    wake = null
  }
  async function* read(): AsyncIterable<T> {
    for (;;) {
      const item = items.shift()
      if (item !== undefined) yield item
      else if (ended) return
      // oxlint-disable-next-line no-await-in-loop -- waits for the next item
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  }
  return {
    push(item) {
      items.push(item)
      notify()
    },
    end() {
      ended = true
      notify()
    },
    items: read(),
  }
}

export type SpawnOptions = {
  command: string[]
  cwd: string
  env: Record<string, string>
  // stderr is Codex's log, never protocol.
  onStderr?: (text: string) => void
}

export function stdioTransport(options: SpawnOptions): Transport & { pid: number } {
  const child = Bun.spawn(options.command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const exited = child.exited.then(() => ({ code: child.exitCode, signal: child.signalCode }))
  const lines = queue<unknown>()
  let open = true

  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line === "") continue
        const json = parseJson(line)
        lines.push(json.ok ? json.value : line)
      }
    }
    lines.end()
  })()

  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of child.stderr) options.onStderr?.(decoder.decode(chunk, { stream: true }))
  })()

  return {
    pid: child.pid,
    messages: lines.items,
    send(message) {
      if (!open) throw new Error("codex app-server is closed")
      void child.stdin.write(JSON.stringify(message) + "\n")
      void child.stdin.flush()
    },
    exited,
    async close() {
      if (open) {
        open = false
        void child.stdin.end()
      }
      // Ending stdin asks app-server to exit; it gets a moment before it is killed.
      const done = await Promise.race([exited.then(() => true), Bun.sleep(2_000).then(() => false)])
      if (!done) child.kill("SIGKILL")
      await exited
    },
  }
}

export function rpcClient(transport: Transport): Rpc {
  let next = 0
  const pending = new Map<RpcId, { method: string; resolve(value: unknown): void; reject(error: Error): void }>()
  const incoming = queue<Incoming>()
  const seen = new Set<string>()

  void (async () => {
    for await (const raw of transport.messages) {
      const parsed = envelope.safeParse(raw)
      if (!parsed.success) {
        log.warn("codex: unreadable message from app-server")
        continue
      }
      const message = parsed.data
      if (message.method !== undefined) {
        if (message.id === undefined)
          incoming.push({
            type: "notification",
            method: message.method,
            params: message.params,
            at: message.emittedAtMs ?? null,
          })
        else incoming.push({ type: "request", id: message.id, method: message.method, params: message.params })
        continue
      }
      const waiting = message.id === undefined ? undefined : pending.get(message.id)
      if (!waiting || message.id === undefined) {
        const key = String(message.id)
        if (!seen.has(key)) log.warn(`codex: a response to no request (${key})`)
        seen.add(key)
        continue
      }
      pending.delete(message.id)
      if (message.error)
        waiting.reject(new RpcError(waiting.method, message.error.code, message.error.message, message.error.data))
      else waiting.resolve(message.result)
    }
    for (const waiting of pending.values()) waiting.reject(new Error(`${waiting.method}: codex app-server ended`))
    pending.clear()
    incoming.end()
  })()

  const send = (message: unknown) => transport.send(message)

  return {
    request(method, params) {
      const own = next++
      return new Promise((resolve, reject: (error: Error) => void) => {
        pending.set(own, { method, resolve, reject })
        try {
          send(params === undefined ? { id: own, method } : { id: own, method, params })
        } catch (error) {
          pending.delete(own)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    notify: (method, params) => send(params === undefined ? { method } : { method, params }),
    respond: (to, result) => send({ id: to, result }),
    fail: (to, code, message) => send({ id: to, error: { code, message } }),
    incoming: incoming.items,
    exited: transport.exited,
    close: () => transport.close(),
  }
}
