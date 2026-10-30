import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dirEntries, hashEntries } from "./tree-hash.ts"

// A change here invalidates every treeHash in mods.json.
test("a folder hashes to its pinned value without .git, and symlinks are reported", () => {
  const files = { "yellowcode-mod.json": "{}", "src/index.ts": "export {}\n", "a.txt": "a" }
  const root = mkdtempSync(join(tmpdir(), "yellowcode-hash-"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  mkdirSync(join(root, ".git"))
  writeFileSync(join(root, ".git", "HEAD"), "ref")

  const folder = dirEntries(root)
  expect(folder.symlinks).toEqual([])
  expect(hashEntries(folder.files)).toBe("sha256-89g0d4xzlKvrqQoR2r2ap9NGLFtz8/lSXiU+YGesIl0=")

  symlinkSync("a.txt", join(root, "link"))
  expect(dirEntries(root).symlinks).toEqual(["link"])
})
