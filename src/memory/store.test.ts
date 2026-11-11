import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { answerImport, importCount } from "./import.ts"
import { listMemories, MAX_MEMORIES, memoryFolder, readMemory, saveMemory } from "./store.ts"
import { applyTidy, tidy, undoTidy } from "./tidy.ts"
import { callMemoryTool } from "./tools.ts"

const temp = realpathSync(mkdtempSync(join(tmpdir(), "yc-memory-")))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const fact = { name: "short-commits", description: "subject only", type: "feedback", body: "One line." } as const

test("saves, updates, recalls and forgets through the tools", () => {
  const folder = join(temp, "tools")
  expect(callMemoryTool("remember", fact, folder)).toEqual({ text: "Saved short-commits.", error: false })
  expect(callMemoryTool("remember", { ...fact, body: "Two lines." }, folder).text).toBe("Updated short-commits.")
  expect(callMemoryTool("recall", { name: "short-commits" }, folder).text).toBe(
    "short-commits (feedback): subject only\n\nTwo lines.",
  )
  expect(readFileSync(join(folder, "MEMORY.md"), "utf8")).toBe("- short-commits (feedback): subject only\n")
  expect(callMemoryTool("recall", {}, folder).text).toBe("Memories:\n- short-commits (feedback): subject only")
  expect(callMemoryTool("forget", { name: "short-commits" }, folder).error).toBe(false)
  expect(callMemoryTool("recall", { name: "short-commits" }, folder).error).toBe(true)
  expect(listMemories(folder)).toEqual([])
})

test("turns down a name that leaves the folder, a credential and a full memory", () => {
  const folder = join(temp, "refused")
  expect(saveMemory(folder, { ...fact, name: "../out" }).ok).toBe(false)
  expect(saveMemory(folder, { ...fact, name: "memory" }).ok).toBe(false)
  expect(existsSync(join(temp, "out.md"))).toBe(false)
  expect(readMemory(folder, "../tools/short-commits")).toBeNull()
  expect(saveMemory(folder, { ...fact, body: "the key is sk-abcdefghijklmnopqrstuvwx" }).ok).toBe(false)
  expect(saveMemory(folder, { ...fact, body: "password: hunter2hunter2" }).ok).toBe(false)

  mkdirSync(folder, { recursive: true })
  for (let i = 0; i < MAX_MEMORIES; i++) writeFileSync(join(folder, `m${i}.md`), "---\ndescription: x\n---\n\nbody\n")
  expect(saveMemory(folder, fact).ok).toBe(false)
  expect(saveMemory(folder, { ...fact, name: "m0" })).toEqual({ ok: true, replaced: true, count: MAX_MEMORIES })
})

test("reads a file as Claude Code writes it", () => {
  const folder = join(temp, "claude")
  mkdirSync(folder)
  writeFileSync(
    join(folder, "talk.md"),
    '---\nname: other-name\ndescription: "reply in Turkish"\nmetadata:\n  node_type: memory\n  type: feedback\n---\n\nBody.\n',
  )
  writeFileSync(join(folder, "bare.md"), "No frontmatter.\n")
  expect(listMemories(folder).map(({ name, description, type, body }) => [name, description, type, body])).toEqual([
    ["bare", "", "project", "No frontmatter."],
    ["talk", "reply in Turkish", "feedback", "Body."],
  ])
})

test("a worktree shares its repository's memory", () => {
  const repo = join(temp, "repo")
  const tree = join(temp, "tree")
  mkdirSync(join(repo, "sub"), { recursive: true })
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stderr: "ignore" })
  git("init", "-q")
  git("commit", "-q", "--allow-empty", "-m", "first")
  git("worktree", "add", "-q", tree)
  expect(memoryFolder(tree, "/m")).toBe(memoryFolder(repo, "/m"))
  expect(memoryFolder(join(repo, "sub"), "/m")).toBe(memoryFolder(repo, "/m"))
  expect(memoryFolder(temp, "/m")).not.toBe(memoryFolder(repo, "/m"))
})

test("brings in Claude Code's files once, without those that hold a credential or are already here", () => {
  const source = join(temp, "claude-memory")
  const folder = join(temp, "imported")
  mkdirSync(source)
  writeFileSync(join(source, "MEMORY.md"), "- [Talk](talk.md)\n")
  writeFileSync(join(source, "talk.md"), "---\ndescription: reply in Turkish\n---\n\nBody.\n")
  writeFileSync(join(source, "key.md"), "---\ndescription: x\n---\n\ntoken: abcdefgh12345678\n")
  writeFileSync(join(source, "short-commits.md"), "---\ndescription: theirs\n---\n\nTheirs.\n")
  expect(saveMemory(folder, fact).ok).toBe(true)
  expect(importCount(folder, source)).toBe(3)
  expect(answerImport(folder, source, true)).toBe(1)
  expect(listMemories(folder).map((memory) => [memory.name, memory.description])).toEqual([
    ["short-commits", "subject only"],
    ["talk", "reply in Turkish"],
  ])
  expect(importCount(folder, source)).toBe(0)
})

test("a tidy-up applies all of the model's list or none of it, and can be taken back", async () => {
  const folder = join(temp, "tidy")
  for (const name of ["a", "b", "c", "d"]) saveMemory(folder, { ...fact, name, body: `Fact ${name}.` })
  const names = () => listMemories(folder).map((memory) => memory.name)
  const merged = { name: "a", description: "merged", type: "feedback", body: "Facts a and b." }

  expect(applyTidy(folder, "no json here").ok).toBe(false)
  expect(applyTidy(folder, JSON.stringify({ write: [], delete: ["zz"] })).ok).toBe(false)
  expect(applyTidy(folder, JSON.stringify({ write: [], delete: ["a", "b", "c"] })).ok).toBe(false)
  const broken = { write: [merged, { ...merged, name: "Not A Name" }], delete: ["b"] }
  expect(applyTidy(folder, JSON.stringify(broken)).ok).toBe(false)
  expect(names()).toEqual(["a", "b", "c", "d"])
  expect(readMemory(folder, "a")?.body).toBe("Fact a.")

  const answer = `Here it is:\n${JSON.stringify({ write: [merged], delete: ["b"] })}`
  expect(await tidy(folder, () => Promise.resolve(answer))).toEqual({ ok: true, written: 1, deleted: 1 })
  expect(names()).toEqual(["a", "c", "d"])
  expect(readMemory(folder, "a")?.body).toBe("Facts a and b.")
  expect(undoTidy(folder)).toBe(true)
  expect(names()).toEqual(["a", "b", "c", "d"])
  expect(readMemory(folder, "a")?.body).toBe("Fact a.")
  expect(undoTidy(folder)).toBe(false)
})
