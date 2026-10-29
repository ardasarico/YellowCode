// Raw scenario steps over any Transport: the recorder runs them on the live service, tests run them on a replay.
import type { Method, Query, Reply, Transport } from "../../src/agents/opencode/transport.ts"

export type Event = { type: string; data: unknown }

export type DriverSocket = {
  // The next frame `match` accepts after the last one this returned, already arrived or not.
  until(what: string, match: (frame: unknown) => boolean, timeoutMs?: number): Promise<unknown>
  send(frame: unknown): void
  close(): void
}

export type Driver = {
  // The project folder sessions are created in; a fixture has it as <root>/project.
  directory: string
  http(method: Method, path: string, body?: unknown, query?: Query): Promise<Reply>
  // The next event of `type` (that `match` accepts) after the last one an `until` returned, already arrived or not.
  until(type: string, match?: (event: Event) => boolean, timeoutMs?: number): Promise<Event>
  socket(name: string): Promise<DriverSocket>
  // Gives the live service time where no event says it is done. A replay does not wait.
  pause(ms: number): Promise<void>
  close(): void
}

export type DriverOptions = {
  directory: string
  onIntent?: (intent: string, args: unknown) => void
  timeoutMs?: number
  live?: boolean
}

export function pick(value: unknown, ...path: (string | number)[]): unknown {
  let at = value
  for (const key of path) {
    if (typeof at !== "object" || at === null) return undefined
    at = Object.entries(at).find(([name]) => name === String(key))?.[1]
  }
  return at
}

export function text(value: unknown, ...path: (string | number)[]): string {
  const found = pick(value, ...path)
  if (typeof found !== "string") throw new Error(`no string at ${path.join(".")}`)
  return found
}

function eventOf(value: unknown): Event | undefined {
  const type = pick(value, "type")
  return typeof type === "string" ? { type, data: pick(value, "data") } : undefined
}

export type Follower<T> = { until(what: string, match: (item: T) => boolean, timeoutMs: number): Promise<T> }

// Keeps every item of `source` so `until` finds items that arrived before it was asked.
export function follow<S, T>(source: AsyncIterable<S>, keep: (value: S) => T | undefined, name: string): Follower<T> {
  const seen: T[] = []
  let cursor = 0
  let wake: (() => void)[] = []
  let broken: unknown

  const notify = () => {
    const waiting = wake
    wake = []
    for (const resolve of waiting) resolve()
  }

  void (async () => {
    try {
      for await (const value of source) {
        const item = keep(value)
        if (item !== undefined) seen.push(item)
        notify()
      }
    } catch (error) {
      broken = error
      notify()
    }
  })()

  return {
    async until(what, match, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const index = seen.findIndex((item, at) => at >= cursor && match(item))
        const found = seen[index]
        if (found !== undefined) {
          cursor = index + 1
          return found
        }
        if (broken) throw new Error(`the ${name} broke while waiting for ${what}`, { cause: broken })
        const left = deadline - Date.now()
        if (left <= 0) throw new Error(`no ${what} within ${timeoutMs} ms`)
        // oxlint-disable-next-line no-await-in-loop -- each look waits for the next item
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left)
          wake.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    },
  }
}

export function createDriver(transport: Transport, options: DriverOptions): Driver {
  const stream = new AbortController()
  const events = follow(transport.events(stream.signal), eventOf, "event stream")
  const sockets: (() => void)[] = []
  const timeout = options.timeoutMs ?? 30_000

  async function http(method: Method, path: string, body?: unknown, query?: Query): Promise<Reply> {
    options.onIntent?.("http", { method, path, ...(query ? { query } : {}), ...(body === undefined ? {} : { body }) })
    const reply = await transport.request({ method, path, query, body })
    if (reply.status >= 400) throw new Error(`${method} ${path} answered ${reply.status} ${JSON.stringify(reply.body)}`)
    return reply
  }

  function until(type: string, match?: (event: Event) => boolean, timeoutMs = timeout) {
    options.onIntent?.("until", { type })
    return events.until(type, (event) => event.type === type && (match?.(event) ?? true), timeoutMs)
  }

  async function socket(name: string): Promise<DriverSocket> {
    options.onIntent?.("socket", { name })
    const open = await transport.socket(name)
    const frames = follow(open.frames, (frame) => frame, `${name} socket`)
    sockets.push(() => open.close())
    return {
      until(what, match, timeoutMs = timeout) {
        options.onIntent?.("frame", { socket: name, what })
        return frames.until(what, match, timeoutMs)
      },
      send(frame) {
        options.onIntent?.("send", { socket: name, frame })
        open.send(frame)
      },
      close: () => open.close(),
    }
  }

  return {
    directory: options.directory,
    http,
    until,
    socket,
    pause: (ms) => (options.live ? Bun.sleep(ms) : Promise.resolve()),
    close() {
      for (const close of sockets) close()
      stream.abort()
    },
  }
}
