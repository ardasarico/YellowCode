import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { readHistory } from "./file-history.ts"

// A stock session (P5 probe, scrubbed): p1 Write creates new.txt, p2 Edits README.md, p3 Write overwrites new.txt,
// p4 appends to README.md with Bash.
const fixture = readFileSync(join(import.meta.dir, "../../../fixtures/rewind/claude-backups.jsonl"), "utf8")
const prompts = [
  "16626daf-1541-4497-99d6-ba25a0591c3a",
  "4c3b8f16-c6e4-41df-bc2a-e5cdacf5c66a",
  "b8a97756-68d0-4452-8d0e-6642412495f9",
  "3994e2f5-ec69-4c0d-bf49-2ad91435369d",
]

const hashOf = (file: string) => new Bun.CryptoHasher("sha256").update(file).digest("hex").slice(0, 16)
const localize = (text: string, dir: string) =>
  text
    .replaceAll("91c8962bec4aaca1", hashOf(`${dir}/README.md`))
    .replaceAll("be044052e7b147c6", hashOf(`${dir}/new.txt`))
    .replaceAll("/project", dir)

test("the transcript maps each prompt to the backups of the files its Edit/Write calls changed", () => {
  const history = readHistory(localize(fixture, "/p"))
  expect(history?.map((prompt) => prompt.uuid)).toEqual(prompts)
  expect(history?.map((prompt) => Object.fromEntries(prompt.writes))).toEqual([
    { "/p/new.txt": "create" },
    { "/p/README.md": "update" },
    { "/p/new.txt": "update" },
    {},
  ])
  expect(history?.[0]?.backups.get("/p/new.txt")).toBeNull()
  expect(history?.[1]?.backups.get("/p/README.md")).toBe(`${hashOf("/p/README.md")}@v1`)
  expect(history?.[2]?.backups.get("/p/new.txt")).toBe(`${hashOf("/p/new.txt")}@v2`)
  expect(history?.[1]?.left.get("/p/README.md")).toContain("line fourteen edited\n")
  expect(history?.[2]?.left.get("/p/new.txt")).toBe("new v2 overwritten\n")
  expect(readHistory('{"type":"file-history-snapshot","snapshot":{}}')).toBeNull()
})

test("a backup belongs to the folder claude recorded, not the cwd a Bash cd left", () => {
  const moved = localize(fixture, "/p").replaceAll('"cwd":"/p"', '"cwd":"/p/sub"')
  expect(readHistory(moved)?.[1]?.backups.get("/p/README.md")).toBe(`${hashOf("/p/README.md")}@v1`)
  // A name whose hash does not match the path is dropped.
  const wrong = localize(fixture, "/p").replaceAll('"realParentDir":"/p"', '"realParentDir":"/p/sub"')
  expect([...(readHistory(wrong)?.[1]?.backups.keys() ?? [])]).toEqual([])
})
