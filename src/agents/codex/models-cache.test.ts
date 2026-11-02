import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cachedWindows } from "./models-cache.ts"

const dir = mkdtempSync(join(tmpdir(), "yc-codex-cache-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const read = (text: string) => {
  const file = join(dir, "models_cache.json")
  writeFileSync(file, text)
  return cachedWindows(file)
}

test("only each slug's context window is read, and a file of another shape reads as none", () => {
  const windows = read(
    JSON.stringify({
      fetched_at: "x",
      models: [
        { slug: "gpt-a", context_window: 272000, display_name: "A" },
        { slug: "gpt-b", context_window: "big" },
        { slug: "gpt-c" },
        "not a model",
      ],
    }),
  )
  expect([...windows]).toEqual([["gpt-a", 272000]])
  expect(read(JSON.stringify([{ slug: "gpt-a", context_window: 1 }])).size).toBe(0)
  expect(read("{ not json").size).toBe(0)
  expect(cachedWindows(join(dir, "missing.json")).size).toBe(0)
})
