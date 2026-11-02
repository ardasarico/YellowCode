import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { feed } from "../../agents/claude/translate.ts"
import { parse } from "../../protocol/parse.ts"
import { createSession } from "../../session/session.ts"
import type { Session } from "../../session/types.ts"
import { parseRecording } from "../../source/recording.ts"
import { panelNodes } from "./agent-panel.tsx"
import { activeNodes, agentTree, childNodes, type ChildView, shellNodes, taskIdOf } from "./tree.ts"

function play(name: string) {
  const path = join(import.meta.dir, "..", "..", "..", "fixtures", "sessions", `${name}.jsonl`)
  const session = createSession()
  for (const entry of parseRecording(readFileSync(path, "utf8")).entries)
    feed(session, entry.dir, parse(entry.line), entry.t)
  return session
}

const replay = (name: string): Session => play(name).state

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

test("agents and shells of rewound prompts leave the tree, the panel and the shell list", () => {
  const session = play("agent-shell")
  const counts = () => [
    agentTree(session.state).length,
    activeNodes(session.state).length,
    shellNodes(session.state).length,
  ]
  expect(counts()).toEqual([1, 1, 1])
  const userId = session.state.items.find((id) => session.state.byId[id]?.kind === "user") ?? ""
  session.rewind({ userId, prompts: 1, files: [], keptFiles: false })
  expect(counts()).toEqual([0, 0, 0])
  session.redo()
  expect(counts()).toEqual([1, 1, 1])
})

test("x stops the node's own task: an agent's, a shell's, and none for a workflow's agent", () => {
  const session = replay("agent-shell")
  const [agent] = agentTree(session)
  const [shell] = shellNodes(session)
  if (!agent || !shell) throw new Error("agent-shell fixture changed")
  expect([taskIdOf(session, agent), taskIdOf(session, shell)]).toEqual(["ac15290731e0393df", "bpry8sht6"])
  const workflow = replay("workflow")
  const ids = agentTree(workflow).map((node) => [node.kind, taskIdOf(workflow, node)])
  expect(ids).toEqual([
    ["workflow", Object.keys(workflow.tasks)[0] ?? ""],
    ["phase", null],
    ["workflow-agent", null],
    ["workflow-agent", null],
  ])
})

const child = (id: string, name: string, state: ChildView["state"]): ChildView => ({
  id,
  name,
  provider: "Pi",
  providerId: "pi",
  model: "pi-model",
  state,
  startedAt: state === "queued" ? null : 1000,
  endedAt: state === "idle" ? 4000 : null,
  problem: null,
  store: createSession(),
})

test("the panel lists the session's children until they close: running, then queued, then the rest", () => {
  const nodes = childNodes([
    child("c1", "reviewer", "idle"),
    child("c2", "tester", "running"),
    child("c3", "x", "queued"),
  ])
  expect(panelNodes(createSession().state, nodes).map((node) => [node.id, node.kind, node.state, node.detail])).toEqual(
    [
      ["child:c2", "child", "running", "Pi"],
      ["child:c3", "child", "queued", "Pi"],
      ["child:c1", "child", "completed", "Pi"],
    ],
  )
  expect(nodes[0]?.durationMs).toBe(3000)
})
