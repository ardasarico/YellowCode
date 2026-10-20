import { z } from "zod"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import { errorResponse } from "../protocol/outgoing.ts"

export class RequestError extends Error {}
export class RequestTimeout extends RequestError {}

export const REQUEST_TIMEOUT_MS = 30_000

export type Requests = {
  // Resolves with the reply's `response`; an error reply, a timeout or close() rejects it with a RequestError.
  send(build: (requestId: string) => string, timeoutMs?: number): Promise<unknown>
  settle(reply: { subtype: string; request_id: string; response?: unknown }): void
  close(reason: string): void
}

type Pending = { resolve: (response: unknown) => void; reject: (error: RequestError) => void; timer: Timer }

const errorReply = z.looseObject({ error: z.string() })

// `write` returns false when the line could not go out.
export function createRequests(write: (line: string) => boolean): Requests {
  const pending = new Map<string, Pending>()
  let counter = 0
  let closed: string | null = null

  return {
    send(build, timeoutMs = REQUEST_TIMEOUT_MS) {
      if (closed !== null) return Promise.reject(new RequestError(closed))
      const id = `yc-${++counter}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          log.warn(`request ${id} timed out after ${timeoutMs} ms`)
          reject(new RequestTimeout(`${id} timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        let written = false
        try {
          written = write(build(id))
        } catch (error) {
          log.warn(`request ${id} could not be written`, error)
        }
        if (written) return
        clearTimeout(timer)
        pending.delete(id)
        reject(new RequestError(`${id} could not be sent`))
      })
    },
    settle(reply) {
      const request = pending.get(reply.request_id)
      if (!request) {
        log.debug(`reply to no pending request: ${reply.request_id}`)
        return
      }
      pending.delete(reply.request_id)
      clearTimeout(request.timer)
      if (reply.subtype === "success") request.resolve(reply.response)
      else request.reject(new RequestError(errorReply.safeParse(reply).data?.error ?? reply.subtype))
    },
    close(reason) {
      closed = reason
      for (const request of pending.values()) {
        clearTimeout(request.timer)
        request.reject(new RequestError(reason))
      }
      pending.clear()
    },
  }
}

const cliRequest = z.looseObject({ request_id: z.string() })

// claude waits for an answer to each of its requests, so one nothing here can handle gets an error reply. Null when
// the line has no request id to answer.
export function refusal(line: string, message: string): string | null {
  const json = parseJson(line)
  const request = json.ok ? cliRequest.safeParse(json.value) : null
  return request?.success ? errorResponse(request.data.request_id, message) : null
}
