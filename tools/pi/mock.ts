// A scripted stand-in for an OpenAI-compatible chat completions endpoint (`POST /v1/chat/completions`, SSE) that the
// isolated pi talks to through its models.json provider. Ids are counters, so recording a scenario again gives the
// same model output.
/* oxlint-disable no-await-in-loop */
import { appendFileSync } from "node:fs"
import type { Server } from "bun"
import { z } from "zod"

export type Output =
  | { type: "text"; text: string }
  // Sent as `reasoning_content`, which pi shows as thinking.
  | { type: "reasoning"; text: string }
  // One of pi's tools (bash, read, edit, write, ...).
  | { type: "call"; name: string; arguments: Record<string, unknown> }

export type Usage = { input: number; output?: number; cached?: number }

// Beyond plain output, an answer can be an HTTP error, never come (until the request is aborted), or wait before it
// starts. With `times`, only the first that many requests get it; later ones get `output`.
export type Answer = {
  output?: Output[]
  error?: { status: number; message: string }
  hang?: boolean
  waitMs?: number
  times?: number
  usage?: Usage
}

// A thread matches when its text is in the last user message of the request; failing that, in any user message. The
// step is the number of assistant tool calls since the user message that holds the match.
export type Thread = { match: string; steps: (Output[] | Answer)[] }
export type Script = { threads: Thread[]; delayMs?: number }

export type Mock = {
  // The provider baseUrl pi is given; it posts to `<baseURL>/chat/completions`.
  baseURL: string
  port: number
  stop(): Promise<void>
}

const part = z.looseObject({ type: z.string(), text: z.string().optional() })
const message = z.looseObject({
  role: z.string(),
  content: z.unknown().optional(),
  tool_calls: z.array(z.unknown()).optional(),
})
const requestBody = z.looseObject({ messages: z.array(message).optional() })
type Message = z.output<typeof message>

const DONE: Output[] = [{ type: "text", text: "Done." }]

const textOf = (entry: Message) => {
  if (typeof entry.content === "string") return entry.content
  const parts = z.array(part).safeParse(entry.content)
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

  function pick(messages: Message[]): Answer {
    const users = messages.flatMap((entry, at) => (entry.role === "user" ? [at] : []))
    const last = users.at(-1) ?? -1
    const lastText = last < 0 ? "" : textOf(messages[last] ?? { role: "user" })
    const thread = longest(lastText) ?? longest(users.map((at) => textOf(messages[at] ?? { role: "user" })).join("\n"))
    if (!thread) return { output: DONE }
    const from = users.findLast((at) => textOf(messages[at] ?? { role: "user" }).includes(thread.match)) ?? last
    const step = messages
      .slice(from + 1)
      .filter((entry) => entry.role === "assistant" && (entry.tool_calls?.length ?? 0) > 0).length
    const found = thread.steps[step] ?? DONE
    const answer = Array.isArray(found) ? { output: found } : found
    return counts(answer, `${thread.match}#${step}`) ? answer : { output: answer.output, usage: answer.usage }
  }

  function stream(outputs: Output[], hang: AbortSignal | null, used: Usage | undefined): ReadableStream {
    const encoder = new TextEncoder()
    const delayMs = script.delayMs ?? 5
    const id = nextId("chatcmpl")
    return new ReadableStream({
      async start(controller) {
        const send = (data: Record<string, unknown>) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
          send({
            id,
            object: "chat.completion.chunk",
            created: 0,
            model: "mock-1",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })
        chunk({ role: "assistant", content: "" })
        let calls = 0
        for (const output of outputs) {
          if (output.type === "text") {
            for (const delta of chunks(output.text)) {
              chunk({ content: delta })
              await sleep(delayMs)
            }
          } else if (output.type === "reasoning") {
            for (const delta of chunks(output.text)) {
              chunk({ reasoning_content: delta })
              await sleep(delayMs)
            }
          } else {
            const index = calls++
            const call = { index, id: nextId("call"), type: "function", function: { name: output.name, arguments: "" } }
            chunk({ tool_calls: [call] })
            await sleep(delayMs)
            chunk({ tool_calls: [{ index, function: { arguments: JSON.stringify(output.arguments) } }] })
          }
        }
        // The client gives up on the request; the stream is gone then.
        if (hang) {
          await new Promise((resolve) => hang.addEventListener("abort", resolve, { once: true }))
          return
        }
        chunk({}, calls > 0 ? "tool_calls" : "stop")
        const input = used?.input ?? 1200
        const output = used?.output ?? 180
        send({
          id,
          object: "chat.completion.chunk",
          created: 0,
          model: "mock-1",
          choices: [],
          usage: {
            prompt_tokens: input,
            completion_tokens: output,
            total_tokens: input + output,
            prompt_tokens_details: { cached_tokens: used?.cached ?? 0 },
          },
        })
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    })
  }

  async function respond(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      appendFileSync(bodiesFile, JSON.stringify({ unexpected: `${req.method} ${path}` }) + "\n")
      return Response.json({}, { status: 404 })
    }
    const raw: unknown = await req.json()
    appendFileSync(bodiesFile, JSON.stringify(raw) + "\n")
    const picked = pick(requestBody.parse(raw).messages ?? [])
    if (picked.waitMs) await sleep(picked.waitMs)
    if (picked.hang && !picked.output) {
      return new Promise<Response>((resolve) =>
        req.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 }))),
      )
    }
    if (picked.error) {
      const error = { error: { type: "error", message: picked.error.message } }
      return Response.json(error, { status: picked.error.status })
    }
    const hang = picked.hang ? req.signal : null
    return new Response(stream(picked.output ?? DONE, hang, picked.usage), {
      headers: { "content-type": "text/event-stream" },
    })
  }

  const server: Server<undefined> = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: respond })
  const port = server.port ?? 0
  return { baseURL: `http://127.0.0.1:${port}/v1`, port, stop: () => server.stop(true) }
}
