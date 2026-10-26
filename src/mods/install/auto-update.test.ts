import { afterAll, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { autoUpdate } from "./auto-update.ts"
import { installAt } from "./install.ts"
import { readCachedList, writeCachedList } from "./list.ts"
import { readRecord } from "./record.ts"
import { dirEntries, hashEntries } from "./tree-hash.ts"

const root = mkdtempSync(join(tmpdir(), "yellowcode-auto-update-"))
const mods = join(root, "mods")
const tarballs = new Map<string, Uint8Array>()
let list: object = { mods: [], revoked: [] }
let fetches = 0

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/list") {
      fetches++
      return Response.json(list)
    }
    const bytes = tarballs.get(path.split("/").at(-1) ?? "")
    return bytes ? new Response(bytes) : new Response("not found", { status: 404 })
  },
})
const env = {
  YELLOWCODE_MOD_LIST: `${server.url.href}list`,
  YELLOWCODE_CODELOAD: server.url.href.replace(/\/$/, ""),
  XDG_CACHE_HOME: join(root, "cache"),
}
const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
Object.assign(process.env, env)
afterAll(() => {
  void server.stop()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

let published = 0
function publish(id: string, version: string) {
  const sha = new Bun.CryptoHasher("sha1").update(`${published++}`).digest("hex")
  const stage = join(root, `stage-${sha}`)
  const tree = join(stage, `${id}-${sha}`)
  mkdirSync(tree, { recursive: true })
  writeFileSync(
    join(tree, "yellowcode-mod.json"),
    JSON.stringify({ id, name: id, version, api: "^0.1", entry: "index.ts" }),
  )
  writeFileSync(join(tree, "index.ts"), `export default {} // ${version}\n`)
  tarballs.set(sha, Bun.spawnSync(["tar", "-czf", "-", "-C", stage, `${id}-${sha}`]).stdout)
  const treeHash = hashEntries(dirEntries(tree).files)
  return { id, name: id, description: "", repo: `someone/${id}`, version, sha, treeHash, api: "^0.1" }
}

async function install(mod: ReturnType<typeof publish>, listed: boolean) {
  const result = await installAt({ ...mod, treeHash: listed ? mod.treeHash : null, listed }, mods)
  if (!result.ok) throw new Error(result.problem)
}

test("listed mods update from a stale list; edited and unlisted ones stay", async () => {
  await install(publish("demo", "1.0.0"), true)
  await install(publish("edited", "1.0.0"), true)
  await install(publish("hand", "1.0.0"), false)
  appendFileSync(join(mods, "edited", "index.ts"), "// mine\n")
  list = { mods: [publish("demo", "2.0.0"), publish("edited", "2.0.0"), publish("hand", "2.0.0")], revoked: [] }
  const day = 24 * 60 * 60 * 1000
  writeCachedList({ mods: [], revoked: [] }, 0)

  const updated: string[] = []
  await autoUpdate(
    mods,
    (id, version) => updated.push(`${id} ${version}`),
    () => day,
  )
  expect(fetches).toBe(1)
  expect(readCachedList()?.fetchedAt).toBe(day)
  expect(updated).toEqual(["demo 2.0.0"])
  expect(readRecord(mods, "demo")?.version).toBe("2.0.0")
  expect(readRecord(mods, "edited")?.version).toBe("1.0.0")
  expect(readRecord(mods, "hand")?.version).toBe("1.0.0")

  await autoUpdate(
    mods,
    () => {},
    () => day + day - 1,
  )
  expect(fetches).toBe(1)
})
