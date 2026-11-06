// A Transport served from a recorded fixture, with no server. Requests match recorded exchanges and sent socket
// frames match recorded `out` frames. Events and `in` frames come out once as many steps (exchanges completed and
// frames sent) have happened as had when they were recorded; an `in` frame also waits for the events recorded before
// it at the same step, so a call reaches the adapter after the events that came first. Event envelopes are kept as recorded, `created` too.
// A recorded stream that a later one followed ends after its last event, as it broke when it was recorded, unless its
// reader closed it then; it ends when its reader closes it too. An `events()` call made after that reads the next
// one. Calls made meanwhile read the same stream. Each socket opened under a name reads the next connection recorded
// under it.
import type { Fixture, HttpLine, SseLine, WsLine } from "./fixture.ts"
import type { Request, Reply, Socket, Transport } from "./transport.ts"
import { withPlaceholder } from "../../agent/yellowcode-prompt.ts"

export type ReplayTransport = Transport & {
  // Events from..to-1 (counted among the fixture's events, every stream's in order) never arrive.
  drop(from: number, to: number): void
  unused(): (HttpLine | WsLine)[]
  // Resolves once every event recorded before intent `n` is out, so a replay waits where the recording paused.
  settled(n: number): Promise<void>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Where two values differ, as paths with both sides, e.g. `body.title: asked "a", recorded "b"`.
function diffOf(asked: unknown, recorded: unknown, path: string, out: string[] = []): string[] {
  if (canonical(asked) === canonical(recorded)) return out
  if (isRecord(asked) && isRecord(recorded)) {
    for (const key of [...new Set([...Object.keys(asked), ...Object.keys(recorded)])].toSorted())
      diffOf(asked[key], recorded[key], path === "" ? key : `${path}.${key}`, out)
    return out
  }
  const shown = (value: unknown) => (value === undefined ? "nothing" : canonical(value).slice(0, 120))
  out.push(`${path}: asked ${shown(asked)}, recorded ${shown(recorded)}`)
  return out
}

const keyOf = (method: string, path: string, query: unknown, body: unknown) =>
  `${method} ${path} ${canonical(query ?? {})} ${canonical(body)}`

export function replayTransport(fixture: Fixture): ReplayTransport {
  const exchanges = fixture.lines.filter((line): line is HttpLine => line.kind === "http").toSorted((a, b) => a.n - b.n)
  const recorded = fixture.lines.filter((line): line is SseLine => line.kind === "sse")
  const lastStream = Math.max(0, ...recorded.map((line) => line.stream ?? 0))
  const closedByReader = new Set(fixture.lines.flatMap((line) => (line.kind === "closed" ? [line.stream] : [])))
  // Streams that ended as recorded; the one after them is the stream of the moment.
  let broken = 0
  const frames = fixture.lines.filter((line): line is WsLine => line.kind === "ws")
  const used = new Set<HttpLine | WsLine>()
  // Sockets opened so far, by name; each reads the connection recorded under its index.
  const opened = new Map<string, number>()
  const dropped = new Set<number>()
  // Events read or dropped, by index among the fixture's events.
  const told = new Set<number>()
  let steps = 0
  let wake: (() => void)[] = []

  const release = () => {
    const waiting = wake
    wake = []
    for (const resolve of waiting) resolve()
  }
  // Whatever was recorded after this step comes out once the caller has gone on.
  const stepped = () => {
    steps += 1
    setTimeout(release, 0)
  }
  const later = (stopped: Promise<void>) => Promise.race([new Promise<void>((resolve) => wake.push(resolve)), stopped])

  function request(sent: Request): Promise<Reply> {
    const req = { ...sent, body: withPlaceholder(sent.body) }
    const key = keyOf(req.method, req.path, req.query, req.body)
    const open = exchanges.filter((exchange) => !used.has(exchange))
    const same = open.filter((exchange) => keyOf(exchange.method, exchange.path, exchange.query, exchange.body) === key)
    // The same request made on another stream, such as a resync after each reconnect, gets the answer of its own.
    const found = same.find((exchange) => (exchange.stream ?? 0) === broken) ?? same[0]
    if (!found) {
      const asked = `${req.method} ${req.path}`
      const closest =
        open.find((exchange) => exchange.method === req.method && exchange.path === req.path) ??
        open.find((exchange) => exchange.path === req.path)
      const near = closest
        ? `closest ${closest.method} ${closest.path} differs at ${diffOf(
            { method: req.method, query: req.query ?? {}, body: req.body },
            { method: closest.method, query: closest.query, body: closest.body },
            "",
          ).join("; ")}`
        : "nothing left on that path"
      return Promise.reject(new Error(`replay: nothing recorded for ${asked}; ${near}`))
    }
    used.add(found)
    stepped()
    return Promise.resolve({ status: found.status, body: found.response })
  }

  async function* events(signal?: AbortSignal): AsyncIterable<unknown> {
    const stream = broken
    const stopped = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
    const mine = recorded.flatMap((line, index) => ((line.stream ?? 0) === stream ? [index] : []))
    let next = 0
    for (;;) {
      // A stream its reader closed is over too; the next `events()` call reads the stream recorded after it.
      if (signal?.aborted) {
        if (stream < lastStream) broken = Math.max(broken, stream + 1)
        return
      }
      const index = mine[next]
      const line = index === undefined ? undefined : recorded[index]
      if (index !== undefined && line && line.after <= steps) {
        if (!dropped.has(index)) yield line.event
        told.add(index)
        next += 1
        setTimeout(release, 0)
        continue
      }
      if (index === undefined && stream < lastStream && !closedByReader.has(stream)) {
        broken = Math.max(broken, stream + 1)
        return
      }
      // oxlint-disable-next-line no-await-in-loop -- waits for the next step to release more
      await later(stopped)
    }
  }

  function socket(name: string): Promise<Socket> {
    const index = opened.get(name) ?? 0
    const lines = frames.filter((line) => line.socket === name && (line.conn ?? 0) === index)
    if (lines.length === 0) return Promise.reject(new Error(`replay: no socket ${name} #${index} recorded`))
    opened.set(name, index + 1)
    const closed = new AbortController()
    const stopped = new Promise<void>((resolve) => closed.signal.addEventListener("abort", () => resolve()))
    const incoming = lines.filter((line) => line.dir === "in")
    const placeOf = new Map(fixture.lines.map((line, place) => [line, place]))
    // The events each `in` frame waits for. An event of a stream that ended was read, or never will be.
    const first = new Map(
      incoming.map((frame) => [
        frame,
        recorded.flatMap((event, at) =>
          event.after === frame.after && (placeOf.get(event) ?? 0) < (placeOf.get(frame) ?? 0) ? [at] : [],
        ),
      ]),
    )
    const due = (frame: WsLine) =>
      frame.after <= steps &&
      (first.get(frame) ?? []).every((at) => told.has(at) || (recorded[at]?.stream ?? 0) < broken)

    // The socket stays open after the last recorded frame, until the caller closes it.
    async function* read(): AsyncIterable<unknown> {
      let next = 0
      for (;;) {
        if (closed.signal.aborted) return
        const line = incoming[next]
        if (line && due(line)) {
          yield line.frame
          next += 1
          continue
        }
        // oxlint-disable-next-line no-await-in-loop -- waits for the next step to release more
        await later(stopped)
      }
    }

    return Promise.resolve({
      frames: read(),
      send(frame) {
        const open = lines.filter((line) => line.dir === "out" && !used.has(line))
        const found = open.find((line) => canonical(line.frame) === canonical(frame))
        if (!found) {
          const near = open[0]
            ? `next recorded differs at ${diffOf(frame, open[0].frame, "frame").join("; ")}`
            : "nothing left"
          throw new Error(`replay: nothing recorded for a frame sent on ${name}; ${near}`)
        }
        used.add(found)
        stepped()
      },
      close: () => closed.abort(),
    })
  }

  return {
    request,
    events,
    socket,
    drop(from, to) {
      for (let index = from; index < to; index++) dropped.add(index)
    },
    unused: () => [
      ...exchanges.filter((exchange) => !used.has(exchange)),
      ...frames.filter((line) => line.dir === "out" && !used.has(line)),
    ],
    async settled(n) {
      const at = fixture.lines.findIndex((line) => line.kind === "intent" && line.n === n)
      const earlier = new Set(at < 0 ? [] : fixture.lines.slice(0, at))
      const due = recorded.flatMap((line, index) => (earlier.has(line) ? [index] : []))
      const out = (index: number) => told.has(index) || dropped.has(index) || (recorded[index]?.stream ?? 0) < broken
      // oxlint-disable-next-line no-await-in-loop -- waits for the next step to release more
      while (!due.every(out)) await later(new Promise<void>(() => {}))
    },
  }
}
