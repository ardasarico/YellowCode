/* oxlint-disable no-await-in-loop */
import { constants } from "node:os"
import { log } from "../log/log.ts"
import type { SessionEnd } from "../session/types.ts"
import { printable } from "../ui/format.ts"
import { CLAUDE_STREAM_ARGS } from "./claude-args.ts"
import { splitLines } from "./lines.ts"
import type { Source, SourceEvent } from "./source.ts"

// `closed` is true when the process ended after close() was called.
export type ClaudeExit = { code: number | null; signal: string | null; stderr: string[]; closed: boolean }
export type ClaudeSource = Source & {
  exited: Promise<ClaudeExit>
  // What is known now; code and signal are both null while the process still runs.
  exitNow(): ClaudeExit
}

// An idle claude ends on its own once its input closes, after the user's SessionEnd hooks.
const CLOSE_GRACE_MS = 5000
const KILL_AFTER_MS = 2000
const STDERR_TAIL = 5

// claude ends on some signals by exiting with 128 + the signal's number itself.
function signalName(code: number | null): string | null {
  if (code === null || code <= 128 || code >= 160) return null
  return Object.entries(constants.signals).find(([, number]) => number === code - 128)?.[0] ?? null
}

export function describeExit(exit: ClaudeExit): SessionEnd {
  const signal = exit.signal ?? signalName(exit.code)
  const text = signal
    ? `Claude Code stopped (${signal})`
    : exit.code
      ? `Claude Code exited with code ${exit.code}`
      : "Claude Code exited"
  return { text, detail: exit.stderr }
}

// A write to a process that has just ended can throw or reject.
function tryWrite(write: () => unknown): void {
  try {
    Promise.resolve(write()).catch((error: unknown) => log.warn("cannot write to claude", error))
  } catch (error) {
    log.warn("cannot write to claude", error)
  }
}

export function createClaudeSource(
  cwd: string,
  running: () => boolean,
  command: string[] = ["claude", ...CLAUDE_STREAM_ARGS],
): ClaudeSource {
  const proc = Bun.spawn(command, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  log.info("claude started", { pid: proc.pid, cwd })
  const alive = () => proc.exitCode === null && proc.signalCode === null
  const queue: SourceEvent[] = []
  let wake: (() => void) | null = null
  let reading = true
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const push = (event: SourceEvent) => {
    queue.push(event)
    wake?.()
  }

  const output = (async () => {
    for await (const line of splitLines(proc.stdout)) push({ dir: "in", line, at: Date.now() })
  })()
    .catch((error: unknown) => log.warn("cannot read claude output", error))
    .finally(() => {
      reading = false
      wake?.()
    })

  const stderr: string[] = []
  const errors = (async () => {
    for await (const line of splitLines(proc.stderr)) {
      log.warn("claude stderr", line)
      // A progress line redraws itself after each \r, so only its last state is kept.
      const shown = printable(line.slice(line.lastIndexOf("\r") + 1)).replaceAll("\t", " ")
      if (!shown.trim()) continue
      stderr.push(shown)
      if (stderr.length > STDERR_TAIL) stderr.shift()
    }
  })().catch((error: unknown) => log.warn("cannot read claude stderr", error))

  void proc.exited.then(() => clearTimeout(timer))
  const exitNow = (): ClaudeExit => ({ code: proc.exitCode, signal: proc.signalCode, stderr: [...stderr], closed })
  const exited = Promise.all([proc.exited, output, errors]).then(() => {
    const exit = exitNow()
    log.info("claude exited", { code: exit.code, signal: exit.signal, closed })
    return exit
  })

  const stop = () => {
    proc.kill("SIGTERM")
    timer = setTimeout(() => proc.kill("SIGKILL"), KILL_AFTER_MS)
  }

  async function* events(): AsyncGenerator<SourceEvent> {
    while (true) {
      const event = queue.shift()
      if (event) yield event
      else if (!reading) return
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  }

  return {
    events: events(),
    exited,
    exitNow,
    send(line) {
      if (closed || !reading || !alive()) {
        log.warn("claude is not running; dropped a line")
        return false
      }
      push({ dir: "out", line, at: Date.now() })
      tryWrite(() => proc.stdin.write(line + "\n"))
      tryWrite(() => proc.stdin.flush())
      return true
    },
    close() {
      if (closed) return
      closed = true
      if (!alive()) return
      tryWrite(() => proc.stdin.end())
      // Closing the input does not stop a turn that is running.
      if (running()) stop()
      else timer = setTimeout(stop, CLOSE_GRACE_MS)
    },
  }
}
