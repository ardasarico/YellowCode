import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSession } from "../session/session.ts"
import type { Session, UserMessage } from "../session/types.ts"
import type { Capture } from "./live-rewind.ts"
import { createFileRewind } from "./rewind-files.ts"
import { openSnapshots } from "./snapshots.ts"

const temp = mkdtempSync(join(tmpdir(), "yellowcode-rewind-files-"))
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

const user = (id: string, uuid: string): UserMessage => ({
  kind: "user",
  id,
  text: id,
  images: [],
  to: null,
  queue: null,
  uuid,
})

test("a rewind after one whose after-snapshot failed touches nothing", async () => {
  const dir = join(temp, "project")
  mkdirSync(dir)
  const old = new Date(Date.now() - 60_000)
  for (const [path, content] of Object.entries({ "p.txt": "base\n", "q.txt": "q0\n" })) {
    writeFileSync(join(dir, path), content)
    utimesSync(join(dir, path), old, old)
  }
  git(dir, "init", "-q", "-b", "main")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "first")
  const snapshots = await openSnapshots(dir)
  if (!snapshots) throw new Error("snapshots off")

  let taken = 0
  const take = async () => {
    const id = `t${taken++}`
    const point = await snapshots.take(id)
    return point ? { ...point, id } : null
  }
  const prompt = async (uuid: string, edit: () => void) => {
    const beforeAt = Date.now()
    const before = await take()
    await Bun.sleep(20)
    edit()
    const after = await take()
    if (!before || !after) throw new Error("no snapshot")
    const changes = await snapshots.changes(before.tree, after.tree)
    const segment = {
      kind: "turn",
      before,
      beforeAt,
      after,
      changes,
      writes: [],
      base: null,
      outside: [],
      outsideKept: [],
    }
    mkdirSync(join(snapshots.store, "prompts"), { recursive: true })
    const manifest = { uuid, sessionId: null, sentAt: beforeAt, segments: [segment], latest: {}, shells: [] }
    writeFileSync(join(snapshots.store, "prompts", `${uuid}.json`), JSON.stringify(manifest))
  }
  await prompt("u1", () => writeFileSync(join(dir, "q.txt"), "q1\n"))
  await prompt("u2", () => writeFileSync(join(dir, "p.txt"), "claude\n"))

  let calls = 0
  // The first rewind's R is call 0, its R_after (failing) call 1.
  const capture: Capture = {
    snapshots: Promise.resolve(snapshots),
    before: async () => {},
    drop: () => {},
    follow: () => {},
    settle: async () => {},
    stop: async () => {},
    snapshot: () => (calls++ === 1 ? Promise.resolve(null) : take()),
    release: () => {},
    asked: async () => {},
    adopt: () => {},
  }
  const session: Session = {
    ...createSession().state,
    items: ["a", "b"],
    byId: { a: user("a", "u1"), b: user("b", "u2") },
  }
  const files = createFileRewind(capture, dir)
  const seen = new Set(["p.txt", "q.txt"])

  expect((await files.rewind(session, "b", seen)).kind).toBe("done")
  writeFileSync(join(dir, "p.txt"), "mine\n")
  expect(await files.rewind(session, "a", seen)).toEqual({
    kind: "failed",
    reason: "the last rewind left no snapshot; /redo or send first",
  })
  expect(readFileSync(join(dir, "p.txt"), "utf8")).toBe("mine\n")
  expect(readFileSync(join(dir, "q.txt"), "utf8")).toBe("q1\n")
})
