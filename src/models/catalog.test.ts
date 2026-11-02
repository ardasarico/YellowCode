import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelGroup } from "../agent/lists.ts"
import { modelGroups, readModels } from "../agents/pi/models.ts"
import { readCatalog, writeCatalog } from "./catalog.ts"

const dir = mkdtempSync(join(tmpdir(), "yc-catalog-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const secrets = {
  baseUrl: "https://example.invalid/v1",
  headers: { "x-key": "secret-value" },
  apiKey: "secret-value",
}

test("no endpoint, header or key reaches the catalog file", () => {
  const file = join(dir, "models.json")
  const pi = modelGroups(readModels({ models: [{ id: "m1", provider: "acme", contextWindow: 1000, ...secrets }] }))
  // An opencode row as it would look if its raw fields slipped through.
  const opencode: ModelGroup[] = [
    {
      provider: { id: "lab", name: "Lab", ...secrets },
      applies: "now" as const,
      models: [
        {
          ref: { provider: "lab", id: "m2" },
          label: "M2",
          note: "",
          resolves: null,
          efforts: [],
          images: false,
          window: 2000,
          ...secrets,
        },
      ],
    },
  ]
  writeCatalog(
    {
      version: 1,
      providers: { pi: { version: "1", at: 1, groups: pi }, opencode: { version: "1", at: 1, groups: opencode } },
    },
    file,
  )
  const written = readFileSync(file, "utf8")
  expect(written).not.toContain("secret-value")
  expect(written).not.toContain("example.invalid")
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readCatalog(file).providers["opencode"]?.groups[0]?.models[0]?.window).toBe(2000)

  const row = { ref: { provider: "acme", id: "m1" }, label: "m1", note: "", resolves: null, efforts: [], images: false }
  const stored = {
    version: "1",
    at: 1,
    groups: [{ provider: null, applies: "now", models: [{ ...row, window: null, ...secrets }] }],
  }
  writeFileSync(file, JSON.stringify({ version: 1, providers: { pi: stored } }))
  expect(readCatalog(file).providers["pi"]?.groups[0]?.models).toHaveLength(1)
  expect(JSON.stringify(readCatalog(file))).not.toContain("secret-value")
})

test("a corrupt file reads as empty", () => {
  const file = join(dir, "corrupt.json")
  writeFileSync(file, "{ not json")
  expect(readCatalog(file)).toEqual({ version: 1, providers: {} })
  writeFileSync(file, JSON.stringify({ version: 1, providers: { pi: { groups: "no" } } }))
  expect(readCatalog(file)).toEqual({ version: 1, providers: {} })
})
