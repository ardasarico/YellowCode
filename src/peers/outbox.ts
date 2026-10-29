import { createConnection } from "node:net"
import { parseJson } from "../json.ts"
import { ANSWER, type PeerAnswer, type PeerMessage } from "./inbox.ts"

const TIMEOUT_MS = 5000
const NOT_ACTIVE: PeerAnswer = { error: "not-active" }

// A session that cannot be reached, or does not answer, counts as not active.
export function deliver(socket: string, message: PeerMessage, timeoutMs = TIMEOUT_MS): Promise<PeerAnswer> {
  return new Promise((resolve) => {
    let reply = ""
    let done = false
    const finish = (answer: PeerAnswer) => {
      if (done) return
      done = true
      connection.destroy()
      resolve(answer)
    }
    const connection = createConnection(socket)
    connection.setTimeout(timeoutMs, () => finish(NOT_ACTIVE))
    connection.on("error", () => finish(NOT_ACTIVE))
    connection.on("close", () => finish(NOT_ACTIVE))
    connection.on("data", (chunk: Buffer) => {
      reply += chunk.toString("utf8")
      const end = reply.indexOf("\n")
      if (end < 0) return
      const json = parseJson(reply.slice(0, end))
      const parsed = json.ok ? ANSWER.safeParse(json.value) : null
      finish(parsed?.success ? parsed.data : NOT_ACTIVE)
    })
    connection.write(`${JSON.stringify(message)}\n`)
  })
}
