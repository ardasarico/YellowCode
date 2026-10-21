import { expect, test } from "bun:test"
import { getTaskOutputRequest } from "../protocol/outgoing.ts"
import { parse } from "../protocol/parse.ts"
import { createSession } from "../session/session.ts"
import type { Requests } from "./requests.ts"
import { createTaskControls } from "./tasks.ts"

const system = (message: Record<string, unknown>) => parse(JSON.stringify({ type: "system", ...message }))
const started = (task_id: string, task_type = "local_bash") =>
  system({ subtype: "task_started", task_id, task_type, is_backgrounded: true })
const ended = (task_id: string) => system({ subtype: "task_notification", task_id, status: "completed", summary: "" })

function fakeRequests() {
  const sent: { line: string; resolve: (response: unknown) => void }[] = []
  const requests: Requests = {
    send: (build) => new Promise((resolve) => sent.push({ line: build(`t-${sent.length + 1}`), resolve })),
    settle: () => {},
    close: () => {},
  }
  const reads = () => sent.map((request) => /"task_id":"(\w+)"/.exec(request.line)?.[1])
  const settle = async () => {
    for (const request of sent) request.resolve({})
    await Bun.sleep(0)
  }
  return { requests, sent, reads, settle }
}

test("a running shell is read one at a time about once a second, once more after its end, and an agent never", async () => {
  let clock = 0
  const { requests, sent, reads, settle } = fakeRequests()
  const session = createSession()
  session.apply("in", started("b1"), 0)
  session.apply("in", started("a1", "local_agent"), 0)
  const tasks = createTaskControls({ requests, session, now: () => clock })

  tasks.tick()
  tasks.tick()
  expect(reads()).toEqual(["b1"])
  await settle()
  tasks.tick()
  expect(reads()).toEqual(["b1"])
  clock = 1000
  tasks.tick()
  await settle()
  session.apply("in", ended("b1"), 0)
  tasks.tick()
  await settle()
  tasks.tick()
  expect(reads()).toEqual(["b1", "b1", "b1"])

  void tasks.stop("b1")
  expect(sent.at(-1)?.line).toContain('"subtype":"stop_task","task_id":"b1"')
})

// Such a shell belongs to an earlier claude (a restored transcript, a crash); this one would read it as empty.
test("a shell that ended before the controls were made is never read", () => {
  const { requests, reads } = fakeRequests()
  const session = createSession()
  session.apply("in", started("b1"), 0)
  session.apply("in", ended("b1"), 0)
  createTaskControls({ requests, session }).tick()
  expect(reads()).toEqual([])
})

test("a late reply to an older read never replaces a newer tail", () => {
  const session = createSession()
  session.apply("in", started("b1"), 0)
  for (const id of ["r1", "r2"]) session.apply("out", parse(getTaskOutputRequest(id, "b1")), 0)
  const reply = (id: string, output: string) =>
    session.apply(
      "in",
      parse(
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: id,
            response: { output, total_bytes: output.length, truncated: false },
          },
        }),
      ),
      0,
    )
  const last = "tick 1\ntick 2\n\n[exited with code 0]\n"
  reply("r2", last)
  reply("r1", "tick 1\n")
  expect(session.state.tasks["b1"]?.output).toBe(last)
})
