// A scripted stand-in for the Anthropic Messages API that the isolated opencode talks to. It runs in the recorder's
// process. Ids are counters, so recording a scenario again gives the same model output.
// Blocks stream one at a time on purpose, paced by `delayMs`.
/* oxlint-disable no-await-in-loop */
import { appendFileSync } from "node:fs"
import type { Server } from "bun"
import { z } from "zod"

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  // Tool names and inputs are opencode's own (shell, read, edit, ...).
  | { type: "tool"; name: string; input: Record<string, unknown> }

// Beyond a plain message, an answer can be an HTTP error in the Anthropic shape, never come (until the request is
// aborted; with `blocks`, it stops unfinished after them), or wait before it starts. With `times`, only the first that
// many requests get it; later ones get `blocks`. A thread's `always` answers every request (up to `times`) before its
// steps are looked at.
// `usage` replaces the input tokens every streamed answer reports (1200, no cache).
export type ApiError = { status: number; type: string; message: string; headers?: Record<string, string> }
export type Usage = { input: number; cacheRead?: number; cacheWrite?: number }
export type Answer = {
  blocks?: Block[]
  error?: ApiError
  hang?: boolean
  waitMs?: number
  times?: number
  usage?: Usage
}

// A thread matches when its text is in the request's user text. All user text counts, because plan mode puts a
// synthetic user message first. The step is the number of assistant messages so far.
export type Thread = { match: string; steps: (Block[] | Answer)[]; always?: Answer }
// `badSummary`: the compaction's summary leaves out the template's headings, so opencode refuses it. `echo`: every
// answer to a thread ends with a text that names the model and effort the request asked for.
export type Script = { threads: Thread[]; title?: string; delayMs?: number; badSummary?: boolean; echo?: boolean }

export type Mock = {
  // The provider baseURL opencode is given; it posts to `<baseURL>/messages`.
  baseURL: string
  port: number
  stop(): Promise<void>
}

// Only the fields the mock reads; the rest of opencode's request passes untouched.
const msg = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))]),
})
const requestBody = z.looseObject({
  model: z.string().optional(),
  stream: z.boolean().optional(),
  messages: z.array(msg).optional(),
  tools: z.array(z.unknown()).optional(),
  output_config: z.looseObject({ effort: z.string().optional() }).optional(),
})
type Msg = z.output<typeof msg>
type Body = z.output<typeof requestBody>

const DONE: Block[] = [{ type: "text", text: "Done." }]

// opencode's compaction asks for a summary with the headings of its template and refuses one without them.
const summaryOf = (template: string) =>
  template
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .flatMap((heading) => [heading, "- (none)"])
    .join("\n")

const textOf = (message: Msg) =>
  typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const chunks = (text: string) => text.match(/[\s\S]{1,12}/g) ?? [""]

export function startMock(script: Script, bodiesFile: string): Mock {
  let messages = 0
  let tools = 0
  const served = new Map<string, number>()

  const counts = (answer: Answer, key: string) => {
    const n = (served.get(key) ?? 0) + 1
    served.set(key, n)
    return answer.times === undefined || n <= answer.times
  }

  function pick(body: Body): Answer {
    const all = body.messages ?? []
    const userText = all
      .filter((m) => m.role === "user")
      .map(textOf)
      .join("\n")
    const template = /<template>([\s\S]*?)<\/template>/.exec(textOf(all.at(-1) ?? { role: "", content: "" }))?.[1]
    if (template) return { blocks: [{ type: "text", text: script.badSummary ? "A summary." : summaryOf(template) }] }
    const thread =
      (body.tools?.length ?? 0) > 0
        ? script.threads
            .filter((t) => userText.includes(t.match))
            .toSorted((a, b) => b.match.length - a.match.length)[0]
        : undefined
    if (!thread) return { blocks: [{ type: "text", text: script.title ?? "Demo session" }] }
    const step = all.filter((m) => m.role === "assistant").length
    if (thread.always && counts(thread.always, `${thread.match}#always`)) return thread.always
    const found = thread.steps[step] ?? DONE
    const answer = Array.isArray(found) ? { blocks: found } : found
    return counts(answer, `${thread.match}#${step}`) ? answer : { blocks: answer.blocks, usage: answer.usage }
  }

  function stream(model: string, blocks: Block[], hang: AbortSignal | null, used: Usage | undefined): ReadableStream {
    const encoder = new TextEncoder()
    const delayMs = script.delayMs ?? 5
    const id = `msg_mock${String(++messages).padStart(4, "0")}`
    return new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        const usage = {
          input_tokens: used?.input ?? 1200,
          output_tokens: 0,
          cache_read_input_tokens: used?.cacheRead ?? 0,
          cache_creation_input_tokens: used?.cacheWrite ?? 0,
        }
        const message = { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage }
        send("message_start", { type: "message_start", message })
        let usedTool = false
        for (const [index, block] of blocks.entries()) {
          if (block.type === "text") {
            send("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "text", text: "" },
            })
            for (const text of chunks(block.text)) {
              send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } })
              await sleep(delayMs)
            }
          } else if (block.type === "thinking") {
            const start = { type: "thinking", thinking: "", signature: "" }
            send("content_block_start", { type: "content_block_start", index, content_block: start })
            for (const thinking of chunks(block.thinking)) {
              const delta = { type: "thinking_delta", thinking }
              send("content_block_delta", { type: "content_block_delta", index, delta })
              await sleep(delayMs)
            }
            const signature = { type: "signature_delta", signature: "mock" }
            send("content_block_delta", { type: "content_block_delta", index, delta: signature })
          } else {
            usedTool = true
            const use = {
              type: "tool_use",
              id: `toolu_mock${String(++tools).padStart(4, "0")}`,
              name: block.name,
              input: {},
            }
            send("content_block_start", { type: "content_block_start", index, content_block: use })
            const delta = { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
            send("content_block_delta", { type: "content_block_delta", index, delta })
            await sleep(delayMs)
          }
          if (hang && index === blocks.length - 1) break
          send("content_block_stop", { type: "content_block_stop", index })
        }
        // The client gives up on the request; the stream is gone then.
        if (hang) {
          await new Promise((resolve) => hang.addEventListener("abort", resolve, { once: true }))
          return
        }
        const stop = { stop_reason: usedTool ? "tool_use" : "end_turn", stop_sequence: null }
        send("message_delta", { type: "message_delta", delta: stop, usage: { output_tokens: 180 } })
        send("message_stop", { type: "message_stop" })
        controller.close()
      },
    })
  }

  async function respond(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 1200 })
    if (req.method !== "POST" || !path.endsWith("/messages")) return Response.json({}, { status: 404 })
    const raw: unknown = await req.json()
    appendFileSync(bodiesFile, JSON.stringify(raw) + "\n")
    const body = requestBody.parse(raw)
    const picked = pick(body)
    if (picked.waitMs) await sleep(picked.waitMs)
    if (picked.hang && !picked.blocks) {
      return new Promise<Response>((resolve) =>
        req.signal.addEventListener("abort", () => resolve(new Response(null, { status: 499 }))),
      )
    }
    if (picked.error) {
      const error = { type: "error", error: { type: picked.error.type, message: picked.error.message } }
      return Response.json(error, { status: picked.error.status, headers: picked.error.headers })
    }
    const model = body.model ?? ""
    const echo = `(${model}, effort ${body.output_config?.effort ?? "none"})`
    const threaded = script.echo && (body.tools?.length ?? 0) > 0
    const blocks = [...(picked.blocks ?? DONE), ...(threaded ? [{ type: "text" as const, text: echo }] : [])]
    if (!body.stream) {
      const content = blocks.map((b) => ({ type: "text", text: b.type === "text" ? b.text : "" }))
      const usage = { input_tokens: 100, output_tokens: 20 }
      return Response.json({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: "end_turn",
        usage,
      })
    }
    const hang = picked.hang ? req.signal : null
    return new Response(stream(model, blocks, hang, picked.usage), { headers: { "content-type": "text/event-stream" } })
  }

  const server: Server<undefined> = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: respond })
  const port = server.port ?? 0
  return { baseURL: `http://127.0.0.1:${port}/v1`, port, stop: () => server.stop(true) }
}
