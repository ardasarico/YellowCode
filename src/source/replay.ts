/* oxlint-disable no-await-in-loop */
import { createSignal, type Accessor } from "solid-js"
import { OWN_ASK, ownAskCall } from "../protocol/messages.ts"
import { parse } from "../protocol/parse.ts"
import { ownAskProblem } from "../session/ask.ts"
import type { Recording, RecordingEntry } from "./recording.ts"
import type { Source, SourceEvent } from "./source.ts"

export type Speed = number | "instant"
export type ReplayStatus = "playing" | "waiting" | "finished"
export type ReplaySource = Source & { status: Accessor<ReplayStatus> }

export function parseSpeed(value: string): Speed | null {
  if (value === "instant") return "instant"
  const speed = Number(value)
  return Number.isFinite(speed) && speed > 0 ? speed : null
}

export function createReplaySource(recording: Recording, speed: Speed): ReplaySource {
  const [status, setStatus] = createSignal<ReplayStatus>("playing")
  let closed = false
  let release: ((line: string) => void) | null = null
  let wakeEarly: (() => void) | null = null
  const permissionRequests = new Set<string>()
  const mainCalls = new Set<string>()

  function waitsForUser(entry: RecordingEntry): "message" | "answer" | null {
    const parsed = parse(entry.line)
    if (parsed.kind !== "message") return null
    const message = parsed.message
    if (message.type === "control_request" && message.request.subtype === "can_use_tool")
      permissionRequests.add(message.request_id)
    if (message.type === "assistant" && !message.parent_tool_use_id)
      for (const block of message.message.content) if (block.type === "tool_use") mainCalls.add(block.id)
    // A call to our own ask waits for the user's answer like a permission ask, unless it was never shown: broken, or
    // a subagent's (its tool_use line comes after the call or names its agent).
    if (
      message.type === "control_request" &&
      message.request.subtype === "mcp_message" &&
      message.request.message.method === "tools/call"
    ) {
      const call = ownAskCall.safeParse(message.request.message.params).data
      if (call && mainCalls.has(call.toolUseId) && ownAskProblem({ toolName: OWN_ASK, input: call.input }) === null)
        permissionRequests.add(message.request_id)
    }
    if (entry.dir !== "out") return null
    if (message.type === "user") return "message"
    if (message.type === "control_response" && permissionRequests.has(message.response.request_id)) return "answer"
    return null
  }

  const gate = () =>
    new Promise<string>((resolve) => {
      release = (line) => {
        release = null
        resolve(line)
      }
    })

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const handle = setTimeout(done, ms)
      function done() {
        clearTimeout(handle)
        wakeEarly = null
        resolve()
      }
      wakeEarly = done
    })

  async function* play(): AsyncGenerator<SourceEvent> {
    let base = 0
    const recordedAt = Date.parse(recording.header.recordedAt)
    let clock = performance.now()

    for (const entry of recording.entries) {
      if (closed) return
      let line = entry.line
      const waits = waitsForUser(entry)
      if (waits) {
        setStatus("waiting")
        const sent = await gate()
        if (closed) return
        // The user's own message takes the recorded one's place; an answer only releases the recorded answer.
        if (waits === "message" && sent) line = sent
        setStatus("playing")
        base = entry.t
        clock = performance.now()
      } else if (speed !== "instant") {
        const wait = clock + (entry.t - base) / speed - performance.now()
        if (wait > 0) await pause(wait)
      }
      if (closed) return
      yield { dir: entry.dir, line, at: recordedAt + entry.t }
    }
    setStatus("finished")
  }

  return {
    events: play(),
    status,
    send(line) {
      release?.(line)
      return true
    },
    close() {
      closed = true
      release?.("")
      wakeEarly?.()
    },
  }
}
