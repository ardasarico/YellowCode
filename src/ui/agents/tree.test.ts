import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "../../protocol/parse.ts"
import { createSession } from "../../session/session.ts"
import type { Session } from "../../session/types.ts"
import { parseRecording } from "../../source/recording.ts"
import { agentTree, barSize } from "./tree.ts"

function replay(name: string): Session {
  const path = join(import.meta.dir, "..", "..", "..", "fixtures", "sessions", `${name}.jsonl`)
  const session = createSession()
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries)
    session.apply(entry.dir, parse(entry.line), entry.t)
  return session.state
}

test("nested agents nest under the agent that launched them", () => {
  const nodes = agentTree(replay("nested-agents"))
  const outer = nodes.find((node) => node.name === "outer")
  expect(nodes.map((node) => [node.name, node.depth, node.parentId])).toEqual([
    ["outer", 1, null],
    ["inner-fg", 2, outer?.id ?? ""],
    ["inner-bg", 2, outer?.id ?? ""],
  ])
})

test("a workflow groups its agents under their phases", () => {
  const session = replay("workflow")
  const nodes = agentTree(session)
  expect(nodes.map((node) => [node.kind, node.name, node.detail, node.state])).toEqual([
    ["workflow", "read-two-files", "Read 2/2", "completed"],
    ["phase", "Read", "2/2", "completed"],
    ["workflow-agent", "read:a.txt", "Read(/Users/user/project/a.txt)", "completed"],
    ["workflow-agent", "read:b.txt", "Read(/Users/user/project/b.txt)", "completed"],
  ])

  const [task] = Object.values(session.tasks)
  const [first, second] = task?.workflow?.agents ?? []
  if (!task?.workflow || !first || !second) throw new Error("workflow fixture changed")
  const queued = { ...second, state: "start", startedAt: null }
  const running = {
    ...session,
    tasks: {
      [task.id]: { ...task, state: "running" as const, workflow: { ...task.workflow, agents: [first, queued] } },
    },
  }
  const shown = agentTree(running).filter((node) => node.kind === "queued" || node.kind === "workflow-agent")
  expect(shown.map((node) => [node.kind, node.name, node.selectable])).toEqual([
    ["workflow-agent", "read:a.txt", true],
    ["queued", "1 agent queued", false],
  ])

  const errors = [
    { ...first, state: "error" },
    { ...second, state: "error" },
  ]
  const failed = { ...session, tasks: { [task.id]: { ...task, workflow: { ...task.workflow, agents: errors } } } }
  const phase = agentTree(failed).find((node) => node.kind === "phase")
  expect([phase?.state, phase?.detail]).toEqual(["failed", "0/2"])
})

test("the workflow bar narrows to 12, then 8 columns, then goes away", () => {
  expect([40, 23, 15, 11].map(barSize)).toEqual([20, 12, 8, 0])
})
