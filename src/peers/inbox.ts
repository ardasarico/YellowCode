import { rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { z } from "zod"
import type { RelayedCall, RelayedReply } from "../agent/agent.ts"
import { parseJson } from "../json.ts"
import { log } from "../log/log.ts"

// Images make a message large; past this the connection is dropped.
const MAX_BYTES = 64 * 1024 * 1024

const MESSAGE = z.object({
  from: z.object({ id: z.string(), title: z.string(), agent: z.string() }),
  to: z.string(),
  broadcast: z.boolean(),
  text: z.string(),
  images: z.array(
    z.object({ mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]), base64: z.string() }),
  ),
})

// A tool call another YellowCode was given for a session it does not run (StartOptions.relay).
const RELAY = z.object({ relay: z.object({ server: z.string(), caller: z.string(), params: z.unknown() }) })

// The session that runs the caller says so at once, and answers once the call is done.
export const RELAY_ANSWER = z.union([
  z.object({ ok: z.literal("claimed") }),
  z.object({ error: z.enum(["not-ours", "failed"]) }),
  z.object({
    relayed: z.union([
      z.object({ error: z.object({ code: z.number(), message: z.string() }) }),
      z.object({ result: z.unknown() }),
    ]),
  }),
])

export const ANSWER = z.union([
  z.object({ ok: z.enum(["run", "queued", "held"]) }),
  z.object({ error: z.enum(["not-active", "hidden", "failed"]) }),
])

export type PeerMessage = z.infer<typeof MESSAGE>
export type PeerAnswer = z.infer<typeof ANSWER>
export type Inbox = { close(): void }
export type Take = (call: RelayedCall, signal: AbortSignal, claim: () => void) => Promise<RelayedReply | null>

const line = (value: unknown) => `${JSON.stringify(value)}\n`

// A passed-on call stays open until it is done; the sender closing it cancels the call.
function takeRelayed(connection: Socket, call: RelayedCall, take: Take): void {
  const control = new AbortController()
  connection.on("close", () => control.abort())
  void take(call, control.signal, () => connection.write(line({ ok: "claimed" })))
    .then((reply) => connection.end(line(reply === null ? { error: "not-ours" } : { relayed: reply })))
    .catch((error: unknown) => {
      log.error("a passed-on call failed", error)
      connection.end(line({ error: "failed" }))
    })
}

// One JSON line in, one JSON line back, per connection; a passed-on call may get a claim line first.
export function openInbox(socket: string, handle: (message: PeerMessage) => PeerAnswer, take: Take): Promise<Inbox> {
  const server = createServer((connection) => {
    const chunks: Buffer[] = []
    let size = 0
    let read = false
    connection.on("error", () => connection.destroy())
    connection.on("data", (chunk: Buffer) => {
      if (read) return
      chunks.push(chunk)
      size += chunk.length
      if (size > MAX_BYTES) {
        connection.destroy()
        return
      }
      if (!chunk.includes(0x0a)) return
      const first = Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? ""
      read = true
      const json = parseJson(first)
      const relayed = json.ok ? RELAY.safeParse(json.value) : null
      if (relayed?.success) return takeRelayed(connection, relayed.data.relay, take)
      const parsed = json.ok ? MESSAGE.safeParse(json.value) : null
      if (!parsed?.success) {
        connection.destroy()
        return
      }
      let answer: PeerAnswer
      try {
        answer = handle(parsed.data)
      } catch (error) {
        log.error("a peer message failed", error)
        answer = { error: "failed" }
      }
      connection.end(line(answer))
    })
  })
  // A file left at this path belongs to a dead process with our pid.
  rmSync(socket, { force: true })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, () => {
      server.off("error", reject)
      resolve({ close: () => server.close() })
    })
  })
}
