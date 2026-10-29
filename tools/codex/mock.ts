// A scripted stand-in for the OpenAI Responses API (`POST /v1/responses`, SSE) that the isolated Codex talks to. It
// runs in the recorder's process. Ids are counters, so recording a scenario again gives the same model output.
/* oxlint-disable no-await-in-loop */
import { appendFileSync } from "node:fs"
import type { Server } from "bun"
import { z } from "zod"

export type Output =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  // A function tool of Codex's (exec_command, request_user_input, ...) or a dynamic tool. Arguments can be read off
  // the request, such as an id an earlier call's output gave.
  | {
      type: "call"
      name: string
      // The namespace a deferred tool came in, such as multi_agent_v1.
      namespace?: string
      arguments: Record<string, unknown> | ((input: Item[]) => Record<string, unknown>)
    }
  // A search of the tools Codex defers (subagent and MCP tools), which it then sends with the next request.
  | { type: "search"; query: string }
  // A web search the provider ran itself, as OpenAI's hosted tool reports one.
  | { type: "websearch"; query: string }
  // A freeform tool, such as apply_patch with a V4A patch.
  | { type: "custom"; name: string; input: string }

export type Usage = { input: number; output?: number; cached?: number; reasoning?: number }

// Beyond plain output, an answer can be an HTTP error, never come (until the request is aborted), or wait before it
// starts. With `times`, only the first that many requests get it; later ones get `output`.
export type Answer = {
  output?: Output[]
  // `type` is the error's kind in the body, such as usage_limit_reached.
  error?: { status: number; message: string; type?: string }
  hang?: boolean
  waitMs?: number
  times?: number
  usage?: Usage
  headers?: Record<string, string>
}

// A thread matches when its text is in the last user message of the request (the prompt of the turn); failing that,
// in any user message. The step is the number of tool calls since the last user message that holds the match (Codex
// adds user messages of its own, such as a subagent's report).
export type Thread = { match: string; steps: (Output[] | Answer)[] }
export type Script = { threads: Thread[]; delayMs?: number }

export type Mock = {
  // The provider base_url Codex is given; it posts to `<baseURL>/responses`.
  baseURL: string
  port: number
  stop(): Promise<void>
}

const part = z.looseObject({ type: z.string(), text: z.string().optional() })
const item = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  content: z.unknown().optional(),
})
const requestBody = z.looseObject({ model: z.string().optional(), input: z.array(item).optional() })
export type Item = z.output<typeof item>

const DONE: Output[] = [{ type: "text", text: "Done." }]
const CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call", "tool_search_call"])

const textOf = (entry: Item) => {
  const parts = z.array(part).safeParse(entry.content)
  if (typeof entry.content === "string") return entry.content
  return parts.success ? parts.data.map((p) => p.text ?? "").join("\n") : ""
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const chunks = (text: string) => text.match(/[\s\S]{1,12}/g) ?? [""]

export function startMock(script: Script, bodiesFile: string): Mock {
  const counters = new Map<string, number>()
  const served = new Map<string, number>()
  const nextId = (prefix: string) => {
    const n = (counters.get(prefix) ?? 0) + 1
    counters.set(prefix, n)
    return `${prefix}_mock${String(n).padStart(4, "0")}`
  }

  const counts = (answer: Answer, key: string) => {
    const n = (served.get(key) ?? 0) + 1
    served.set(key, n)
    return answer.times === undefined || n <= answer.times
  }

  const longest = (text: string) =>
    script.threads.filter((t) => text.includes(t.match)).toSorted((a, b) => b.match.length - a.match.length)[0]

  function pick(input: Item[]): Answer {
    const users = input.flatMap((entry, at) => (entry.role === "user" ? [at] : []))
    const last = users.at(-1) ?? -1
    const lastText = last < 0 ? "" : textOf(input[last] ?? {})
    const thread = longest(lastText) ?? longest(users.map((at) => textOf(input[at] ?? {})).join("\n"))
    if (!thread) return { output: DONE }
    const from = users.findLast((at) => textOf(input[at] ?? {}).includes(thread.match)) ?? last
    const step = input.slice(from + 1).filter((entry) => CALLS.has(entry.type ?? "")).length
    const found = thread.steps[step] ?? DONE
    const answer = Array.isArray(found) ? { output: found } : found
    return counts(answer, `${thread.match}#${step}`) ? answer : { output: answer.output, usage: answer.usage }
  }

  function stream(
    outputs: Output[],
    request: Item[],
    hang: AbortSignal | null,
    used: Usage | undefined,
  ): ReadableStream {
    const encoder = new TextEncoder()
    const delayMs = script.delayMs ?? 5
    const response = nextId("resp")
    return new ReadableStream({
      async start(controller) {
        const send = (data: Record<string, unknown>) =>
          controller.enqueue(encoder.encode(`event: ${String(data["type"])}\ndata: ${JSON.stringify(data)}\n\n`))
        send({ type: "response.created", response: { id: response } })
        for (const [index, output] of outputs.entries()) {
          const at = { output_index: index }
          if (output.type === "text") {
            const id = nextId("msg")
            const base = { type: "message", id, role: "assistant" }
            send({ type: "response.output_item.added", ...at, item: { ...base, content: [] } })
            for (const delta of chunks(output.text)) {
              send({ type: "response.output_text.delta", ...at, item_id: id, content_index: 0, delta })
              await sleep(delayMs)
            }
            const content = [{ type: "output_text", text: output.text, annotations: [] }]
            send({ type: "response.output_item.done", ...at, item: { ...base, status: "completed", content } })
          } else if (output.type === "reasoning") {
            const id = nextId("rs")
            send({ type: "response.output_item.added", ...at, item: { type: "reasoning", id, summary: [] } })
            send({ type: "response.reasoning_summary_part.added", ...at, item_id: id, summary_index: 0 })
            for (const delta of chunks(output.text)) {
              send({ type: "response.reasoning_summary_text.delta", ...at, item_id: id, summary_index: 0, delta })
              await sleep(delayMs)
            }
            const summary = [{ type: "summary_text", text: output.text }]
            const done = { type: "reasoning", id, summary, encrypted_content: `encrypted-${id}` }
            send({ type: "response.output_item.done", ...at, item: done })
          } else if (output.type === "call") {
            const base = {
              type: "function_call",
              id: nextId("fc"),
              call_id: nextId("call"),
              name: output.name,
              ...(output.namespace === undefined ? {} : { namespace: output.namespace }),
            }
            send({ type: "response.output_item.added", ...at, item: { ...base, arguments: "" } })
            await sleep(delayMs)
            const args = typeof output.arguments === "function" ? output.arguments(request) : output.arguments
            const done = { ...base, arguments: JSON.stringify(args), status: "completed" }
            send({ type: "response.output_item.done", ...at, item: done })
          } else if (output.type === "websearch") {
            const base = { type: "web_search_call", id: nextId("ws") }
            send({ type: "response.output_item.added", ...at, item: { ...base, status: "in_progress" } })
            await sleep(delayMs)
            const action = { type: "search", query: output.query }
            send({ type: "response.output_item.done", ...at, item: { ...base, status: "completed", action } })
          } else if (output.type === "search") {
            const base = { type: "tool_search_call", id: nextId("ts"), call_id: nextId("call"), execution: "client" }
            send({ type: "response.output_item.added", ...at, item: { ...base, arguments: {} } })
            await sleep(delayMs)
            const done = { ...base, arguments: { query: output.query, limit: 8 }, status: "completed" }
            send({ type: "response.output_item.done", ...at, item: done })
          } else {
            const base = { type: "custom_tool_call", id: nextId("ctc"), call_id: nextId("call"), name: output.name }
            send({ type: "response.output_item.added", ...at, item: { ...base, input: "" } })
            await sleep(delayMs)
            send({
              type: "response.output_item.done",
              ...at,
              item: { ...base, input: output.input, status: "completed" },
            })
          }
        }
        // The client gives up on the request; the stream is gone then.
        if (hang) {
          await new Promise((resolve) => hang.addEventListener("abort", resolve, { once: true }))
          return
        }
        const input = used?.input ?? 1200
        const output = used?.output ?? 180
        const usage = {
          input_tokens: input,
          input_tokens_details: { cached_tokens: used?.cached ?? 0 },
          output_tokens: output,
          output_tokens_details: { reasoning_tokens: used?.reasoning ?? 0 },
          total_tokens: input + output,
        }
        send({ type: "response.completed", response: { id: response, usage } })
        controller.close()
      },
    })
  }

  async function respond(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (req.method !== "POST" || !path.endsWith("/responses")) {
      appendFileSync(bodiesFile, JSON.stringify({ unexpected: `${req.method} ${path}` }) + "\n")
      return Response.json({}, { status: 404 })
    }
    const raw: unknown = await req.json()
    appendFileSync(bodiesFile, JSON.stringify(raw) + "\n")
    const input = requestBody.parse(raw).input ?? []
    const picked = pick(input)
    if (picked.waitMs) await sleep(picked.waitMs)
    if (picked.hang && !picked.output) {
      return new Promise<Response>((resolve) =>
        req.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 }))),
      )
    }
    if (picked.error) {
      const error = { error: { type: picked.error.type ?? "error", message: picked.error.message } }
      return Response.json(error, { status: picked.error.status, headers: picked.headers })
    }
    const hang = picked.hang ? req.signal : null
    return new Response(stream(picked.output ?? DONE, input, hang, picked.usage), {
      headers: { "content-type": "text/event-stream", ...picked.headers },
    })
  }

  const server: Server<undefined> = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: respond })
  const port = server.port ?? 0
  return { baseURL: `http://127.0.0.1:${port}/v1`, port, stop: () => server.stop(true) }
}
