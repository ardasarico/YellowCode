import { rmSync } from "node:fs"
import { createServer } from "node:net"
import { z } from "zod"
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

export const ANSWER = z.union([
  z.object({ ok: z.enum(["run", "queued", "held"]) }),
  z.object({ error: z.enum(["not-active", "hidden"]) }),
])

export type PeerMessage = z.infer<typeof MESSAGE>
export type PeerAnswer = z.infer<typeof ANSWER>
export type Inbox = { close(): void }

// One JSON line in, one JSON line back, per connection.
export function openInbox(socket: string, handle: (message: PeerMessage) => PeerAnswer): Promise<Inbox> {
  const server = createServer((connection) => {
    const chunks: Buffer[] = []
    let size = 0
    connection.on("error", () => connection.destroy())
    connection.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      if (size > MAX_BYTES) {
        connection.destroy()
        return
      }
      if (!chunk.includes(0x0a)) return
      const line = Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? ""
      const json = parseJson(line)
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
        answer = { error: "not-active" }
      }
      connection.end(`${JSON.stringify(answer)}\n`)
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
