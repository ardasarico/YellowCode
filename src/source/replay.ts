/* oxlint-disable no-await-in-loop */
import { createSignal, type Accessor } from "solid-js"
import { isUserMessageLine } from "../protocol/parse.ts"
import type { Recording } from "./recording.ts"
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
  let release: (() => void) | null = null
  let wakeEarly: (() => void) | null = null

  const gate = () =>
    new Promise<void>((resolve) => {
      release = () => {
        release = null
        resolve()
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
      if (entry.dir === "out" && isUserMessageLine(entry.line)) {
        setStatus("waiting")
        await gate()
        if (closed) return
        setStatus("playing")
        base = entry.t
        clock = performance.now()
      } else if (speed !== "instant") {
        const wait = clock + (entry.t - base) / speed - performance.now()
        if (wait > 0) await pause(wait)
      }
      if (closed) return
      yield { dir: entry.dir, line: entry.line, at: recordedAt + entry.t }
    }
    setStatus("finished")
  }

  return {
    events: play(),
    status,
    send() {
      release?.()
    },
    close() {
      closed = true
      release?.()
      wakeEarly?.()
    },
  }
}
