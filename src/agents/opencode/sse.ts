// opencode's `/api/event` stream, connected again whenever it breaks. Each connection's first frame is opencode's own
// `server.connected`. The service counts as gone once the stream has failed to come back for GONE_MS and
// `/api/info` fails too.
import { log } from "../../log/log.ts"
import { LineTooLong } from "../../source/lines.ts"
import type { Transport } from "./transport.ts"

export type Clock = { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }

const FIRST_MS = 250
const MAX_MS = 5000
const GONE_MS = 10_000

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    }),
}

export const backoff = (attempt: number) => Math.min(FIRST_MS * 2 ** attempt, MAX_MS)

export type StreamItem = { type: "frame"; frame: unknown } | { type: "gone" }

async function answers(transport: Transport): Promise<boolean> {
  const reply = await transport.request({ method: "GET", path: "/api/info" }).catch(() => null)
  return reply !== null && reply.status === 200
}

// Ends when `signal` aborts, or after `gone`.
export async function* eventStream(
  transport: Transport,
  signal: AbortSignal,
  clock: Clock = realClock,
): AsyncIterable<StreamItem> {
  let attempt = 0
  let downSince: number | null = null
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      for await (const frame of transport.events(signal)) {
        attempt = 0
        downSince = null
        yield { type: "frame", frame }
      }
    } catch (error) {
      log.warn("opencode: the event stream broke", error instanceof Error ? error.message : "")
      if (error instanceof LineTooLong) {
        yield { type: "gone" }
        return
      }
    }
    if (signal.aborted) return
    downSince ??= clock.now()
    // oxlint-disable-next-line no-await-in-loop -- the service is checked only once the stream stayed away
    if (clock.now() - downSince >= GONE_MS && !(await answers(transport))) {
      yield { type: "gone" }
      return
    }
    // oxlint-disable-next-line no-await-in-loop -- waits before the next try
    await clock.sleep(backoff(attempt), signal)
    attempt += 1
    if (signal.aborted) return
  }
}
