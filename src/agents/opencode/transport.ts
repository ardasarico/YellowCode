import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { z } from "zod"
import { parseJson } from "../../json.ts"
import { log } from "../../log/log.ts"
import { LINE_LIMIT, LineTooLong } from "../../source/lines.ts"

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
export type Query = Record<string, string>

export type Request = { method: Method; path: string; query?: Query; body?: unknown }
export type Reply = { status: number; body: unknown }

export type Socket = {
  // Frames from opencode, each text frame's JSON as is (text that is not JSON as a string). Ends when it closes.
  frames: AsyncIterable<unknown>
  send(frame: unknown): void
  close(): void
}

export type Transport = {
  request(req: Request): Promise<Reply>
  // One SSE stream of `GET /api/event`, each frame's JSON as is (text that is not JSON as a string). It ends when the
  // stream closes or `signal` aborts, and throws when opencode sends its stream failure frame.
  events(signal?: AbortSignal): AsyncIterable<unknown>
  // A client-mcp websocket: YellowCode hosts the MCP server `name` and opencode is its client. Resolves once open.
  socket(name: string): Promise<Socket>
}

export type Endpoint = { url: string; auth?: { type: "basic"; username: string; password: string } }

// The event name of the last frame of an effect SSE stream that failed on the server. Its data is effect's Cause,
// a list of reasons such as `[{"_tag":"Die","defect":...}]`.
export const STREAM_FAILURE = "effect/http-api/stream/failure"

export function urlOf(base: string, path: string, query: Query = {}): string {
  const url = new URL(path, base)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}

// 204 and empty bodies give undefined; a body that is not JSON stays text.
function bodyOf(text: string): unknown {
  if (text === "") return undefined
  const parsed = parseJson(text)
  return parsed.ok ? parsed.value : text
}

const tagged = z.looseObject({ _tag: z.string() })

function tagOf(body: unknown): string {
  const parsed = tagged.safeParse(body)
  if (!parsed.success) return ""
  const { _tag: tag } = parsed.data
  return tag
}

function failureOf(data: unknown): string {
  return Array.isArray(data) ? tagOf(data[0]) : ""
}

export type SseFrame = { name: string | null; data: unknown }

// Frames end at a blank line. `data:` lines carry the frame, `event:` names it, `:` lines are heartbeats.
export function createSseParser(): (chunk: string) => SseFrame[] {
  let buffer = ""
  return (chunk) => {
    buffer = (buffer + chunk).replaceAll("\r\n", "\n")
    const frames: SseFrame[] = []
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const lines = buffer.slice(0, end).split("\n")
      buffer = buffer.slice(end + 2)
      const field = (name: string) =>
        lines.filter((line) => line.startsWith(`${name}:`)).map((line) => line.slice(name.length + 1).trimStart())
      const data = field("data")
      if (data.length === 0) continue
      frames.push({ name: field("event").at(-1) ?? null, data: bodyOf(data.join("\n")) })
    }
    if (buffer.length > LINE_LIMIT) throw new LineTooLong()
    return frames
  }
}

// One async iterable fed by callbacks, for socket frames and the adapter's events.
export function channel<T>() {
  // Boxed, so an undefined item is not taken for an empty queue.
  const items: { item: T }[] = []
  let ended = false
  let wake: (() => void) | undefined
  const poke = () => {
    wake?.()
    wake = undefined
  }
  return {
    // Items pushed after the end are dropped.
    push(...more: T[]) {
      if (ended) return
      items.push(...more.map((item) => ({ item })))
      poke()
    },
    end() {
      ended = true
      poke()
    },
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      for (;;) {
        const next = items.shift()
        if (next) yield next.item
        else if (ended) return
        // oxlint-disable-next-line no-await-in-loop -- waits for the next pushed item
        else await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  }
}

async function textOf(response: IncomingMessage): Promise<string> {
  response.setEncoding("utf8")
  let text = ""
  for await (const chunk of response) text += String(chunk)
  return text
}

function logFailure(what: string, status: number, body: unknown): void {
  const tag = tagOf(body)
  log.warn(`opencode: ${what} answered ${status}${tag === "" ? "" : ` ${tag}`}`)
}

async function* framesOf(response: IncomingMessage, signal?: AbortSignal): AsyncIterable<SseFrame> {
  response.setEncoding("utf8")
  const parse = createSseParser()
  try {
    for await (const chunk of response) yield* parse(String(chunk))
  } catch (error) {
    if (error instanceof LineTooLong) throw error
    if (!signal?.aborted) throw new Error("opencode: the event stream broke", { cause: error })
  } finally {
    response.destroy()
  }
}

// A service that stays up but stops answering must not hold a prompt, an ask reply or the messages after them.
const REQUEST_MS = 60_000
// A client-mcp socket that has not opened by then is given up on.
const SOCKET_OPEN_MS = 10_000

// Requests go through node:http, not fetch: Bun's fetch sends even loopback requests through HTTP_PROXY, and with
// them the password. The password stays in this closure: it is never logged and never part of an error.
export function httpTransport(endpoint: Endpoint, directory: string): Transport {
  // Encoded as opencode's own clients do; the service decodes it.
  const headers: Record<string, string> = { "x-opencode-directory": encodeURIComponent(directory) }
  if (endpoint.auth) {
    const pair = `${endpoint.auth.username}:${endpoint.auth.password}`
    headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`
  }

  function open(method: Method, url: string, body?: string, signal?: AbortSignal): Promise<IncomingMessage> {
    const send = new URL(url).protocol === "https:" ? httpsRequest : httpRequest
    const sent = body === undefined ? headers : { ...headers, "content-type": "application/json" }
    return new Promise((resolve, reject) => {
      const req = send(url, { method, headers: sent, signal }, resolve)
      req.on("error", reject)
      req.end(body)
    })
  }

  async function request(req: Request): Promise<Reply> {
    const what = `${req.method} ${req.path}`
    const body = req.body === undefined ? undefined : JSON.stringify(req.body)
    const signal = AbortSignal.timeout(REQUEST_MS)
    const late = () => {
      log.warn(`opencode: ${what} did not answer`)
      return new Error(`opencode: ${what} did not answer`)
    }
    const response = await open(req.method, urlOf(endpoint.url, req.path, req.query), body, signal).catch(() => {
      if (signal.aborted) throw late()
      log.warn(`opencode: ${what} failed to connect`)
      throw new Error(`opencode: ${what} failed to connect`)
    })
    const status = response.statusCode ?? 0
    const text = await textOf(response).catch(() => {
      throw late()
    })
    const reply = { status, body: bodyOf(text) }
    if (status >= 400) logFailure(what, status, reply.body)
    return reply
  }

  async function* events(signal?: AbortSignal): AsyncIterable<unknown> {
    const response = await open("GET", urlOf(endpoint.url, "/api/event"), undefined, signal).catch(() => {
      if (signal?.aborted) return undefined
      throw new Error("opencode: the event stream failed to connect")
    })
    if (!response) return
    const status = response.statusCode ?? 0
    if (status !== 200) {
      logFailure("the event stream", status, bodyOf(await textOf(response)))
      throw new Error(`opencode: the event stream answered ${status}`)
    }
    for await (const frame of framesOf(response, signal)) {
      if (frame.name === STREAM_FAILURE) throw new Error(`opencode: the event stream failed (${failureOf(frame.data)})`)
      yield frame.data
    }
  }

  function socket(name: string): Promise<Socket> {
    const url = new URL(urlOf(endpoint.url, "/api/experimental/client-mcp", { "location[directory]": directory, name }))
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const frames = channel<unknown>()
    const failed = () => {
      log.warn(`opencode: the ${name} socket failed to open`)
      return new Error(`opencode: the ${name} socket failed to open`)
    }
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url, { headers })
      } catch {
        reject(failed())
        return
      }
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") frames.push(bodyOf(event.data))
      })
      ws.addEventListener("close", () => frames.end())
      const timer = setTimeout(() => {
        reject(failed())
        ws.close()
      }, SOCKET_OPEN_MS)
      ws.addEventListener("open", () => {
        clearTimeout(timer)
        resolve({
          frames,
          send(frame) {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
          },
          close: () => ws.close(1000),
        })
      })
      ws.addEventListener("error", () => {
        if (ws.readyState === WebSocket.OPEN) return
        clearTimeout(timer)
        reject(failed())
      })
    })
  }

  return { request, events, socket }
}
