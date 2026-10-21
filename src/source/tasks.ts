import { log } from "../log/log.ts"
import { getTaskOutputRequest, stopTaskRequest } from "../protocol/outgoing.ts"
import type { SessionStore } from "../session/session.ts"
import { isShell } from "../session/shells.ts"
import { RequestError, type Requests, RequestTimeout, RequestUnsent } from "./requests.ts"

const OUTPUT_EVERY_MS = 1000
// A shell that starts or ends is read at the next poll, not a whole OUTPUT_EVERY_MS later.
const POLL_MS = 200
const OUTPUT_TIMEOUT_MS = 5000
const STOP_TIMEOUT_MS = 5000

export type TaskControls = {
  // Polls until close(): the output tail of every running background shell, and once more of each after it ended.
  start(): void
  close(): void
  tick(): void
  stop(taskId: string): Promise<void>
}

// Live only. The session fills each shell's output from the echoed request and its reply. A shell that had already
// ended when the controls were made (restored from a transcript, stopped by a crash) is never read: this claude does
// not know it and would answer with an empty tail.
export function createTaskControls(options: {
  requests: Requests
  session: SessionStore
  // Milliseconds from a clock that never steps back.
  now?: () => number
}): TaskControls {
  const { requests, session, now = () => performance.now() } = options
  const reading = new Set<string>()
  // Shells whose read after the end has gone out.
  const done = new Set(
    Object.values(session.state.tasks)
      .filter((task) => isShell(task) && task.state !== "running")
      .map((task) => task.id),
  )
  const readAt = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | undefined

  const read = (taskId: string) => {
    reading.add(taskId)
    readAt.set(taskId, now())
    requests
      .send((id) => getTaskOutputRequest(id, taskId), OUTPUT_TIMEOUT_MS, { quiet: true })
      .catch((error: unknown) => log.debug("get_task_output failed", error instanceof Error ? error.message : error))
      .finally(() => reading.delete(taskId))
  }

  const tick = () => {
    if (session.state.status === "ended") return
    for (const task of Object.values(session.state.tasks)) {
      // A read sent before the end has no exit marker, so the last read waits for it.
      if (!isShell(task) || reading.has(task.id) || done.has(task.id)) continue
      if (task.state !== "running") done.add(task.id)
      else if (now() - (readAt.get(task.id) ?? -Infinity) < OUTPUT_EVERY_MS) continue
      read(task.id)
    }
  }

  return {
    start() {
      timer ??= setInterval(tick, POLL_MS)
    },
    close() {
      clearInterval(timer)
      timer = undefined
    },
    tick,
    stop(taskId) {
      log.info("stop task", { taskId })
      return requests
        .send((id) => stopTaskRequest(id, taskId), STOP_TIMEOUT_MS)
        .then(
          () => undefined,
          (error: unknown) => {
            log.warn("stop task failed", error instanceof Error ? error.message : error)
            if (error instanceof RequestTimeout) throw new RequestError("Claude Code did not answer")
            if (error instanceof RequestUnsent) throw new RequestError("Claude Code is not running")
            throw error
          },
        )
    },
  }
}
