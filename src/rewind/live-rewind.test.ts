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
  inputText: "",
  input,
  summary: "",
  status: "done",
  result: "",
  children: [],
  patch: null,
  createdFile: false,
  images: [],
  unchanged: false,
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

test("an agent segment keeps its snapshot when the prompt whose take closed it is dropped", async () => {
  const dir = join(temp, "project")
  mkdirSync(dir)
  writeFileSync(join(dir, "a.txt"), "a\n")
  git(dir, "init", "-q", "-b", "main")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "first")

  // A session whose chat the test writes itself.
  const real = createSession()
  const [state, setState] = createStore<Session>({ ...real.state })
  const session: SessionStore = { ...real, state }
  const capture = createCapture(dir)
  const snapshots = await capture.snapshots
  if (!snapshots) throw new Error("snapshots off")
  capture.follow(session)

  // Prompt A starts a background agent and its turn ends.
  await capture.before("A", null, session)
  const agent = tool("agent", "Agent", {}, { status: "running", agent: running })
  setState("byId", { u: { kind: "user", id: "u", text: "", images: [], to: null, queue: null, uuid: "A" }, agent })
  setState("items", ["u", "agent"])
  setState("turn", "user")
  setState("turn", null)

  // The agent writes while no turn runs; prompt B's before closes that segment, then B is dropped.
  writeFileSync(join(dir, "b.txt"), "b\n")
  setState("byId", "w", tool("w", "Write", { file_path: join(dir, "b.txt"), content: "b\n" }, { createdFile: true }))
  setState("byId", "agent", { ...agent, children: ["w"] })
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
