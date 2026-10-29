import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "solid-js/store"
import { createSession, type SessionStore } from "../session/session.ts"
import type { Agent, Session, ToolCall } from "../session/types.ts"
import { createCapture, readManifest } from "./live-rewind.ts"
import { refsUnder } from "./outside.ts"

const temp = realpathSync(mkdtempSync(join(tmpdir(), "yellowcode-live-")))
const saved = { HOME: process.env["HOME"], YELLOWCODE_SNAPSHOT_DIR: process.env["YELLOWCODE_SNAPSHOT_DIR"] }
mkdirSync(join(temp, "home"))
process.env["HOME"] = join(temp, "home")
process.env["YELLOWCODE_SNAPSHOT_DIR"] = join(temp, "store")
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(temp, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

const tool = (id: string, name: string, input: unknown, extra: Partial<ToolCall> = {}): ToolCall => ({
  kind: "tool",
  id,
  name,
  toolKind: "other",
  title: name,
  server: null,
  inputText: "",
  input,
  summary: "",
  detail: null,
  background: false,
  status: "done",
  result: "",
  children: [],
  patch: null,
  createdFile: false,
  content: null,
  images: [],
  unchanged: false,
  count: null,
  files: [],
  questions: null,
  outcome: null,
  agent: null,
  taskId: null,
  ...extra,
})

const running: Agent = {
  name: "",
  task: "",
  prompt: "",
  type: "",
  model: "",
  tokens: 0,
  state: "running",
  toolUses: 0,
  durationMs: 0,
  report: "",
  error: null,
  activity: "",
  stoppedByUser: false,
}

// A project whose session's prompt A started a background agent that wrote b.txt after A's turn ended. The test
// writes the chat itself.
async function agentWroteAfterTurn(name: string) {
  const dir = join(temp, name)
  mkdirSync(dir)
  writeFileSync(join(dir, "a.txt"), "a\n")
  git(dir, "init", "-q", "-b", "main")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "first")

  const real = createSession()
  const [state, setState] = createStore<Session>({ ...real.state })
  const session: SessionStore = { ...real, state }
  const capture = createCapture(dir)
  const snapshots = await capture.snapshots
  if (!snapshots) throw new Error("snapshots off")
  const unfollow = capture.follow(session)

  await capture.before("A", null, session)
  const agent = tool("agent", "Agent", {}, { status: "running", agent: running })
  setState("byId", { u: { kind: "user", id: "u", text: "", images: [], to: null, queue: null, uuid: "A" }, agent })
  setState("items", ["u", "agent"])
  setState("turn", "user")
  setState("turn", null)

  writeFileSync(join(dir, "b.txt"), "b\n")
  const file = join(dir, "b.txt")
  const written = { path: file, change: "create" as const, movedTo: null, patch: null, after: "b\n" }
  setState(
    "byId",
    "w",
    tool("w", "Write", { file_path: file, content: "b\n" }, { toolKind: "write", createdFile: true, files: [written] }),
  )
  setState("byId", "agent", { ...agent, children: ["w"] })
  return { capture, snapshots, session, unfollow }
}

test("an agent segment keeps its snapshot when the prompt whose take closed it is dropped", async () => {
  const { capture, snapshots, session } = await agentWroteAfterTurn("project")

  // Prompt B's before closes the agent's segment, then B is dropped.
  await capture.before("B", null, session)
  capture.drop("B")
  await capture.settle()
  // A drop goes through the store's queue, which this call waits for.
  await Bun.sleep(10)
  await snapshots.ignored([])

  const segments = readManifest(snapshots.store, "A")?.segments
  expect(segments?.map((segment) => segment.kind)).toEqual(["turn", "agent"])
  const after = segments?.[1]?.after?.id
  expect(after).toBeString()
  expect(await refsUnder(snapshots.store, `refs/yc/${after}`)).toEqual([`refs/yc/${after}`])
})

test("a session no longer followed still closes its agent's segment", async () => {
  const { capture, snapshots, unfollow } = await agentWroteAfterTurn("left")

  unfollow()
  await capture.settle()

  expect(readManifest(snapshots.store, "A")?.segments.map((segment) => segment.kind)).toEqual(["turn", "agent"])
})
