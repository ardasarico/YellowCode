import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dirEntries, hashEntries, hashTarball } from "./tree-hash.ts"

test("a folder and its tarball hash the same, and symlinks are reported", async () => {
  const files = { "yellowcode-mod.json": "{}", "src/index.ts": "export {}\n", "a.txt": "a" }
  const root = mkdtempSync(join(tmpdir(), "yellowcode-hash-"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  mkdirSync(join(root, ".git"))
  writeFileSync(join(root, ".git", "HEAD"), "ref")

  const tarball = Object.fromEntries(Object.entries(files).map(([path, content]) => [`repo-abc/${path}`, content]))
  const bytes = await new Bun.Archive(tarball, { compress: "gzip" }).bytes()
  const folder = dirEntries(root)
  expect(folder.symlinks).toEqual([])
  expect(hashEntries(folder.files)).toBe(await hashTarball(bytes))
  expect(hashEntries(folder.files)).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/)

  symlinkSync("a.txt", join(root, "link"))
  expect(dirEntries(root).symlinks).toEqual(["link"])
})
