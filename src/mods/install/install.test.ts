import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { linkRuntime } from "../runtime.ts"
import { installAt } from "./install.ts"
import { readRecord, writeRecord } from "./record.ts"
import { dirEntries, hashEntries } from "./tree-hash.ts"

const root = mkdtempSync(join(tmpdir(), "yellowcode-install-"))
const tarballs = new Map<string, Uint8Array>()
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const sha = new URL(request.url).pathname.match(/^\/someone\/demo\/tar\.gz\/([0-9a-f]{40})$/)?.[1]
    const bytes = sha && tarballs.get(sha)
    return bytes ? new Response(bytes) : new Response("not found", { status: 404 })
  },
})
const saved = process.env["YELLOWCODE_CODELOAD"]
process.env["YELLOWCODE_CODELOAD"] = server.url.href.replace(/\/$/, "")
afterAll(() => {
  void server.stop()
  if (saved === undefined) delete process.env["YELLOWCODE_CODELOAD"]
  else process.env["YELLOWCODE_CODELOAD"] = saved
})

const manifest = (fields: object = {}) =>
  JSON.stringify({
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    api: "^0.2",
    agents: "any",
    entry: "index.ts",
    ...fields,
  })

// Serves the files as codeload would at a new SHA and returns the SHA and the folder's tree hash.
function publish(files: Record<string, string>, symlinks: Record<string, string> = {}): { sha: string; hash: string } {
  const sha = new Bun.CryptoHasher("sha1").update(`${tarballs.size}`).digest("hex")
  const stage = join(root, `stage-${sha}`)
  const tree = join(stage, `demo-${sha}`)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, path)), { recursive: true })
    writeFileSync(join(tree, path), content)
  }
  for (const [path, link] of Object.entries(symlinks)) symlinkSync(link, join(tree, path))
  if (files["package.json"]?.includes("file:")) {
    const lock = Bun.spawnSync([process.execPath, "install", "--lockfile-only", "--config=/dev/null"], { cwd: tree })
    if (lock.exitCode !== 0) throw new Error(lock.stderr.toString())
  }
  const tar = Bun.spawnSync(["tar", "-czf", "-", "-C", stage, `demo-${sha}`])
  tarballs.set(sha, tar.stdout)
  return { sha, hash: hashEntries(dirEntries(tree).files) }
}

function withDependency(name: string): Record<string, string> {
  return {
    "yellowcode-mod.json": manifest(),
    "index.ts": "export default {}\n",
    "package.json": JSON.stringify({ name: "demo", private: true, dependencies: { [name]: `file:./vendor/${name}` } }),
    [`vendor/${name}/package.json`]: JSON.stringify({ name, version: "1.0.0" }),
  }
}

// Every path under the folder with its file content or link target.
function snapshot(folder: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) out[path] = `-> ${readlinkSync(path)}`
      else if (stat.isDirectory()) {
        out[path] = "dir"
        walk(path)
      } else out[path] = readFileSync(path, "utf8")
    }
  }
  walk(folder)
  return out
}

test("installAt installs a pinned mod and refuses bad ones without touching the mods folder", async () => {
  const mods = join(root, "mods")
  mkdirSync(join(mods, "demo"), { recursive: true })
  writeFileSync(join(mods, "demo", "yellowcode-mod.json"), manifest({ version: "0.9.0" }))
  writeRecord(mods, "demo", {
    source: "github:someone/demo",
    sha: "0".repeat(40),
    treeHash: "sha256-old",
    version: "0.9.0",
    listed: true,
    installedAt: "2026-10-01T00:00:00.000Z",
  })
  linkRuntime(mods)
  const before = snapshot(mods)

  const plain = { "yellowcode-mod.json": manifest(), "index.ts": "export default {}\n" }
  const good = publish(withDependency("left-pad"))
  const cases = [
    { name: "hash mismatch", ...good, hash: publish(plain).hash, problem: "tree hash mismatch" },
    { name: "symlink", ...publish(plain, { link: "index.ts" }), problem: "the mod has symlinks: link" },
    { name: "shared copy", ...publish(withDependency("solid-js")), problem: "installs its own node_modules/solid-js" },
    {
      name: "no bun.lock",
      ...publish({ ...plain, "package.json": JSON.stringify({ name: "demo" }) }),
      problem: "package.json but no bun.lock",
    },
    {
      name: "wrong id",
      ...publish({ ...plain, "yellowcode-mod.json": manifest({ id: "other" }) }),
      problem: 'id "other" is not the folder name "demo"',
    },
    {
      name: "incompatible",
      ...publish({ ...plain, "yellowcode-mod.json": manifest({ api: "^9" }) }),
      problem: "needs a newer YellowCode · update YellowCode",
    },
    { name: "missing commit", sha: "f".repeat(40), hash: null, problem: "HTTP 404" },
  ]
  for (const item of cases) {
    // oxlint-disable-next-line no-await-in-loop -- one install at a time against the same folder
    const result = await installAt(
      { id: "demo", repo: "someone/demo", sha: item.sha, treeHash: item.hash, listed: true },
      mods,
    )
    expect(result.ok ? "installed" : result.problem, item.name).toContain(item.problem)
    expect(snapshot(mods), item.name).toEqual(before)
  }

  const result = await installAt(
    { id: "demo", repo: "someone/demo", sha: good.sha, treeHash: good.hash, listed: true },
    mods,
  )
  if (!result.ok) throw new Error(result.problem)
  expect(readRecord(mods, "demo")).toEqual(result.record)
  expect(result.record).toMatchObject({
    source: "github:someone/demo",
    sha: good.sha,
    treeHash: good.hash,
    version: "1.0.0",
  })
  expect(existsSync(join(mods, "demo", "node_modules", "left-pad", "package.json"))).toBe(true)
  expect(readdirSync(mods).toSorted()).toEqual([".installed", "demo", "node_modules"])
})

test("a failed install into a new mods folder removes the folder again", async () => {
  const mods = join(root, "fresh", "config", "mods")
  const result = await installAt(
    { id: "demo", repo: "someone/demo", sha: "e".repeat(40), treeHash: null, listed: false },
    mods,
  )
  expect(result).toEqual({ ok: false, problem: "download failed: HTTP 404" })
  expect(existsSync(join(root, "fresh"))).toBe(false)
})
