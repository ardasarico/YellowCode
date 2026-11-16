import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ListedMod } from "../src/mods/install/list.ts"
import { droppedProblems, manifestMismatch, screenshotProblem } from "./mods-check.ts"

const mod = (id: string): ListedMod => ({
  id,
  name: "Demo",
  description: "Does a thing.",
  repo: `someone/${id}`,
  version: "1.0.0",
  sha: "a".repeat(40),
  treeHash: `sha256-${"A".repeat(43)}=`,
  api: "^0.2",
  agents: "any",
})

test("a mod taken out of mods[] needs a revoke of every version", () => {
  const before = [mod("kept"), mod("dropped")]
  const mods = [mod("kept")]
  expect(droppedProblems(before, { mods, revoked: [] })).toHaveLength(1)
  expect(
    droppedProblems(before, { mods, revoked: [{ id: "dropped", versions: ["1.0.0"], reason: "bad" }] }),
  ).toHaveLength(1)
  expect(droppedProblems(before, { mods, revoked: [{ id: "dropped", versions: "all", reason: "bad" }] })).toEqual([])
})

test("the list entry must match the manifest's name and description too", () => {
  const manifest = { ...mod("demo"), entry: "index.ts" }
  expect(manifestMismatch(mod("demo"), manifest)).toBeNull()
  expect(manifestMismatch(mod("demo"), { ...manifest, name: "Other" })).toBe(
    'name is "Demo" in the list but "Other" in the manifest',
  )
  expect(manifestMismatch(mod("demo"), { ...manifest, description: "" })).toBe(
    'description is "Does a thing." in the list but "" in the manifest',
  )
})

test("a screenshot must be in the commit, a real PNG or JPEG, and at most 1 MB", () => {
  const folder = mkdtempSync(join(tmpdir(), "yellowcode-screenshots-"))
  writeFileSync(join(folder, "cover.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))
  writeFileSync(join(folder, "photo.jpg"), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))
  writeFileSync(join(folder, "fake.png"), "<svg></svg>")
  writeFileSync(join(folder, "huge.png"), new Uint8Array(1024 * 1024 + 1))
  expect(screenshotProblem(folder, "cover.png")).toBeNull()
  expect(screenshotProblem(folder, "photo.jpg")).toBeNull()
  expect(screenshotProblem(folder, "missing.png")).toBe("screenshot missing.png is not in the commit")
  expect(screenshotProblem(folder, "fake.png")).toBe("screenshot fake.png is not a PNG or JPEG image")
  expect(screenshotProblem(folder, "huge.png")).toBe("screenshot huge.png is over 1 MB")
})
