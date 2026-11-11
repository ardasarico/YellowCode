import { afterAll, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRecord } from "./record.ts"
import { dirEntries, hashEntries } from "./tree-hash.ts"

const root = mkdtempSync(join(tmpdir(), "yellowcode-cli-"))
const mods = join(root, "home", "mods")
const tarballs = new Map<string, Uint8Array>()
const manifests = new Map<string, string>()
const heads = new Map<string, string>()
let list: object = { mods: [], revoked: [] }

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/list") return Response.json(list)
    const tarball = path.match(/^\/codeload\/[\w-]+\/[\w-]+\/tar\.gz\/(\w+)$/)?.[1]
    if (tarball && tarballs.has(tarball)) return new Response(tarballs.get(tarball))
    const head = path.match(/^\/api\/repos\/([\w-]+\/[\w-]+)\/commits\/HEAD$/)?.[1]
    if (head && heads.has(head)) return new Response(heads.get(head))
    const manifest = path.match(/^\/raw\/[\w-]+\/[\w-]+\/(\w+)\/yellowcode-mod\.json$/)?.[1]
    if (manifest && manifests.has(manifest)) return new Response(manifests.get(manifest))
    return new Response("not found", { status: 404 })
  },
})
afterAll(() => void server.stop())

let published = 0
// Serves a mod as GitHub would: its repo's HEAD moves to a new SHA with this tarball and manifest.
function publish(repo: string, id: string, version: string) {
  const sha = new Bun.CryptoHasher("sha1").update(`${published++}`).digest("hex")
  const stage = join(root, `stage-${sha}`)
  const tree = join(stage, `repo-${sha}`)
  mkdirSync(tree, { recursive: true })
  const manifest = JSON.stringify({ id, name: id, version, api: "^0.2", agents: "any", entry: "index.ts" })
  writeFileSync(join(tree, "yellowcode-mod.json"), manifest)
  writeFileSync(join(tree, "index.ts"), `export default {} // ${version}\n`)
  tarballs.set(sha, Bun.spawnSync(["tar", "-czf", "-", "-C", stage, `repo-${sha}`]).stdout)
  manifests.set(sha, manifest)
  heads.set(repo, sha)
  return { id, repo, sha, version, treeHash: hashEntries(dirEntries(tree).files) }
}

const listed = (mod: ReturnType<typeof publish>) => ({
  ...mod,
  name: mod.id,
  description: "",
  api: "^0.2",
  agents: "any",
})

async function run(args: string, answers?: string) {
  const child = Bun.spawn([process.execPath, "src/index.tsx", "mod", ...args.split(" ")], {
    cwd: join(import.meta.dir, "../../.."),
    stdin: answers === undefined ? "ignore" : new Blob([answers]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      YELLOWCODE_HOME: join(root, "home"),
      YELLOWCODE_MOD_LIST: `${server.url.href}list`,
      YELLOWCODE_CODELOAD: `${server.url.href}codeload`,
      YELLOWCODE_GITHUB_API: `${server.url.href}api`,
      YELLOWCODE_RAW: `${server.url.href}raw`,
    },
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, output: stdout + stderr }
}

test("mod add, update and remove", async () => {
  const demo = publish("someone/demo", "demo", "1.0.0")
  list = { mods: [listed(demo), listed(publish("someone/hand", "hand", "1.0.0"))], revoked: [] }
  const added = await run("add demo")
  expect(added.output).toContain("Installed demo 1.0.0")
  expect(added.code).toBe(0)
  expect(readRecord(mods, "demo")).toMatchObject({ sha: demo.sha, listed: true })

  publish("someone/extra", "extra", "0.1.0")
  const declined = await run("add github:someone/extra")
  expect(declined.output).toContain("⚠ extra is not on the YellowCode list.")
  expect(declined.code).toBe(1)
  expect(existsSync(join(mods, "extra"))).toBe(false)
  expect(await run("add github:someone/extra", "y\n")).toMatchObject({ code: 0 })
  expect(readRecord(mods, "extra")).toMatchObject({ source: "github:someone/extra", listed: false })

  publish("someone/clash", "demo", "9.0.0")
  expect(await run("add github:someone/clash", "y\n")).toEqual({
    code: 1,
    output: "demo is a mod on the YellowCode list; install it with yellowcode mod add demo\n",
  })
  mkdirSync(join(mods, "hand"))
  expect(await run("add hand")).toMatchObject({ code: 1, output: "hand is a local mod; remove its folder first\n" })

  const demo2 = publish("someone/demo", "demo", "2.0.0")
  const extra2 = publish("someone/extra", "extra", "0.2.0")
  list = { mods: [listed(demo2)], revoked: [] }
  const updated = await run("update", "y\n")
  expect(updated.output).toContain("Updated demo 1.0.0 -> 2.0.0")
  expect(updated.output).toContain("Updated extra 0.1.0 -> 0.2.0")
  expect(readRecord(mods, "extra")?.sha).toBe(extra2.sha)

  appendFileSync(join(mods, "demo", "index.ts"), "// mine\n")
  list = { mods: [listed(publish("someone/demo", "demo", "3.0.0"))], revoked: [] }
  expect(await run("update demo")).toMatchObject({ code: 0, output: "demo: edited locally, not updated\n" })
  expect(readRecord(mods, "demo")?.version).toBe("2.0.0")

  expect(await run("remove extra", "y\n")).toMatchObject({ code: 0 })
  expect(existsSync(join(mods, "extra"))).toBe(false)
  expect(readRecord(mods, "extra")).toBeNull()
  // Each run starts the real entry point, which loads the whole app.
}, 30_000)
