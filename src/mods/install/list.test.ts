import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fetchList, parseList, readCachedList, writeCachedList } from "./list.ts"

const entry = {
  id: "ci-status",
  name: "CI status",
  description: "Shows CI",
  repo: "someone/ci-status",
  version: "0.3.1",
  sha: "a".repeat(40),
  treeHash: `sha256-${"A".repeat(43)}=`,
  api: "^0.2",
  agents: "any",
}
const list = { mods: [entry], revoked: [{ id: "old", versions: "all", reason: "broken" }] }

const saved = { YELLOWCODE_MOD_LIST: process.env["YELLOWCODE_MOD_LIST"], XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"] }
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("a malformed list is rejected with the first problem named", () => {
  expect(parseList(list).ok).toBe(true)
  expect(parseList({ mods: [{ ...entry, sha: "abc1234" }], revoked: [] })).toEqual({
    ok: false,
    problem: "mods.json: mods.0.sha: must be a full 40-character commit SHA",
  })
  expect(parseList({ mods: [entry, entry], revoked: [] })).toEqual({
    ok: false,
    problem: "mods.json: mods.1.id: is listed twice",
  })
})

test("a fetched list goes through the cache", async () => {
  using server = Bun.serve({ port: 0, fetch: () => Response.json(list) })
  process.env["YELLOWCODE_MOD_LIST"] = `${server.url.href}mods.json`
  process.env["XDG_CACHE_HOME"] = mkdtempSync(join(tmpdir(), "yellowcode-cache-"))

  expect(readCachedList()).toBeNull()
  const fetched = await fetchList()
  if (!fetched.ok) throw new Error(fetched.problem)
  writeCachedList(fetched.list, 1000)
  expect(readCachedList()).toEqual({ list: fetched.list, fetchedAt: 1000 })
})
