// A Transport served from a recorded fixture, with no app-server. A request we send is matched to the first unused
// recorded one with the same method and params, and its recorded response comes back under our id. Our answer to a
// server request must equal the recorded one. Messages from app-server come out in recorded order, each once as many
// messages have been sent as had been when it arrived (a response also waits for its request). A recording with more
// than one app-server is replayed one transport per `connection`, in the order they were spawned.
import type { ExitLine, Fixture, InLine, OutLine } from "./fixture.ts"
import { queue, type Exit, type RpcId, type Transport } from "./transport.ts"

export type ReplayTransport = Transport & {
  unused(): OutLine[]
  // Resolves once every message recorded before intent `n` is out, so a replay waits where the recording paused.
  settled(n: number): Promise<void>
}

export function canonical(value: unknown): string {
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

// Where two values differ, as paths with both sides, e.g. `params.cwd: asked "a", recorded "b"`.
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

type Shape = { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: unknown }

function shapeOf(message: unknown): Shape {
  if (!isRecord(message)) return {}
  const { id, method } = message
  return {
    ...message,
    id: typeof id === "number" || typeof id === "string" ? id : undefined,
    method: typeof method === "string" ? method : undefined,
  }
}

const isRequest = (shape: Shape) => shape.method !== undefined && shape.id !== undefined
const isResponse = (shape: Shape) => shape.method === undefined && shape.id !== undefined

export function replayTransport(fixture: Fixture, connection = 0): ReplayTransport {
  const own = (line: OutLine | InLine | ExitLine) => (line.c ?? 0) === connection
  const outs = fixture.lines.filter((line): line is OutLine => line.kind === "out" && own(line))
  const later = fixture.lines.filter(
    (line): line is InLine | ExitLine => (line.kind === "in" || line.kind === "exit") && own(line),
  )
  const used = new Set<OutLine>()
  // A recorded request's id, by the id we sent it under.
  const ours = new Map<RpcId, RpcId>()
  const messages = queue<unknown>()
  let sent = 0
  let next = 0
  let closed = false
  const exit = Promise.withResolvers<Exit>()
  const wake: (() => void)[] = []

  const finish = (code: Exit) => {
    closed = true
    messages.end()
    exit.resolve(code)
    for (const resolve of wake.splice(0)) resolve()
  }

  // Lets out everything that is due, in order; the first one not due holds back the rest.
  const release = () => {
    for (;;) {
      const line = later[next]
      if (closed || !line || line.after > sent) break
      if (line.kind === "exit") {
        next += 1
        finish({ code: line.code, signal: line.signal })
        return
      }
      const shape = shapeOf(line.msg)
      if (isResponse(shape)) {
        const asked = [...ours.entries()].find(([, recorded]) => recorded === shape.id)?.[0]
        if (asked === undefined) break
        messages.push({ ...shape, id: asked })
      } else messages.push(line.msg)
      next += 1
    }
    for (const resolve of wake.splice(0)) resolve()
  }

  function send(message: unknown): void {
    if (closed) throw new Error("replay: the transport is closed")
    const asked = shapeOf(message)
    const open = outs.filter((line) => !used.has(line))
    let found: OutLine | undefined
    if (isResponse(asked)) {
      found = open.find((line) => isResponse(shapeOf(line.msg)) && shapeOf(line.msg).id === asked.id)
      const answer = { result: asked.result, error: asked.error }
      if (!found) throw new Error(`replay: no answer to server request ${String(asked.id)} recorded`)
      const recorded = shapeOf(found.msg)
      const differs = diffOf(answer, { result: recorded.result, error: recorded.error }, "")
      if (differs.length > 0)
        throw new Error(`replay: the answer to server request ${String(asked.id)} differs at ${differs.join("; ")}`)
    } else {
      const key = canonical(asked.params)
      found = open.find((line) => {
        const shape = shapeOf(line.msg)
        return shape.method === asked.method && isRequest(shape) === isRequest(asked) && canonical(shape.params) === key
      })
      if (!found) {
        const closest = open.find((line) => shapeOf(line.msg).method === asked.method)
        const near = closest
          ? `closest differs at ${diffOf(asked.params, shapeOf(closest.msg).params, "params").join("; ")}`
          : "nothing left with that method"
        throw new Error(`replay: nothing recorded for ${String(asked.method)}; ${near}`)
      }
      const recorded = shapeOf(found.msg).id
      if (asked.id !== undefined && recorded !== undefined) ours.set(asked.id, recorded)
    }
    used.add(found)
    sent += 1
    // What was recorded after this message comes out once the caller has gone on.
    setTimeout(release, 0)
  }

  setTimeout(release, 0)

  return {
    messages: messages.items,
    send,
    exited: exit.promise,
    close() {
      if (!closed) finish({ code: 0, signal: null })
      return Promise.resolve()
    },
    unused: () => outs.filter((line) => !used.has(line)),
    async settled(n) {
      const at = fixture.lines.findIndex((line) => line.kind === "intent" && line.n === n)
      const due = fixture.lines
        .slice(0, at < 0 ? 0 : at)
        .filter((line) => (line.kind === "in" || line.kind === "exit") && own(line))
      for (;;) {
        if (closed || next >= due.length) return
        // oxlint-disable-next-line no-await-in-loop -- waits for the next release
        await new Promise<void>((resolve) => wake.push(resolve))
      }
    },
  }
}
