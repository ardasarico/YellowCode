import { createConnection } from "node:net"
import type { RelayedCall, RelayedReply } from "../agent/agent.ts"
import { parseJson } from "../json.ts"
import { ANSWER, type PeerAnswer, type PeerMessage, RELAY_ANSWER } from "./inbox.ts"
import { forgetPeer } from "./registry.ts"

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
    connection.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") forgetPeer(socket)
      finish(NOT_ACTIVE)
    })
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

// Passes a call on to one session; null when it is not that session's caller, or it cannot be reached. Once it claims
// the call there is no timeout: an ask waits for the user.
export function relay(
  socket: string,
  call: RelayedCall,
  signal: AbortSignal,
  claimMs = TIMEOUT_MS,
): Promise<RelayedReply | null> {
  return new Promise((resolve) => {
    let buffer = ""
    let done = false
    const finish = (reply: RelayedReply | null) => {
      if (done) return
      done = true
      signal.removeEventListener("abort", stop)
      connection.destroy()
      resolve(reply)
    }
    const stop = () => finish(null)
    if (signal.aborted) return resolve(null)
    signal.addEventListener("abort", stop)
    const connection = createConnection(socket)
    connection.setTimeout(claimMs, stop)
    connection.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") forgetPeer(socket)
      finish(null)
    })
    connection.on("close", stop)
    connection.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const json = parseJson(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        const answer = json.ok ? RELAY_ANSWER.safeParse(json.value).data : undefined
        if (answer && "ok" in answer) {
          connection.setTimeout(0)
          continue
        }
        return finish(answer && "relayed" in answer ? answer.relayed : null)
      }
    })
    connection.write(`${JSON.stringify({ relay: call })}\n`)
  })
}
