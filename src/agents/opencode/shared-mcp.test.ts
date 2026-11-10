import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpLaunch } from "../../agent/agent.ts"
import { configOf, foreignOf, startSharedMcp, sweepOf, type Entry } from "./shared-mcp.ts"
import type { Request, Transport } from "./transport.ts"

test("stdio and http servers map to opencode's local and remote config", () => {
  expect(configOf({ name: "a", command: "npx", args: ["-y", "pkg"], env: { K: "v" }, cwd: "/w" })).toEqual({
    config: { type: "local", command: ["npx", "-y", "pkg"], environment: { K: "v" }, cwd: "/w" },
  })
  expect(configOf({ name: "a", command: "x", args: [], env: {} })).toEqual({
    config: { type: "local", command: ["x"] },
  })
  expect(configOf({ name: "r", url: "https://h/mcp", headers: {} })).toEqual({
    config: { type: "remote", url: "https://h/mcp" },
  })
  expect(configOf({ name: "r", url: "https://h/mcp", headers: { A: "b" }, type: "http" })).toEqual({
    config: { type: "remote", url: "https://h/mcp", headers: { A: "b" }, oauth: false },
  })
  expect(configOf({ name: "s", url: "https://h/sse", headers: {}, type: "sse" })).toHaveProperty("problem")
})

// The folder's config file has the user's own X and Y, and the folder lists `added` too; PUT of "bad" is refused with
// a message that quotes its secret. A session runs a turn while `busy` says so.
function fakeTransport(sent: string[], added: string[] = [], busy = () => false): Transport {
  return {
    request(req: Request) {
      sent.push(`${req.method} ${req.path}`)
      if (req.path === "/api/mcp") {
        const data = ["X", "Y", ...added].map((name) => ({ name, status: { status: "connected" } }))
        return Promise.resolve({ status: 200, body: { data } })
      }
      if (req.path === "/api/config")
        return Promise.resolve({
          status: 200,
          body: [{ type: "document", info: { mcp: { servers: { X: {}, Y: {} } } } }],
        })
      if (req.path === "/api/session") {
        const time = busy() ? { created: 1, updated: 3, busy: 2 } : { created: 1, updated: 3, busy: 1, idle: 2 }
        return Promise.resolve({ status: 200, body: { data: [{ id: "s", time }], cursor: { next: null } } })
      }
      if (req.method === "PUT" && req.path.endsWith("/bad"))
        return Promise.resolve({ status: 400, body: { _tag: "Bad", message: "token secret-1234 rejected" } })
      return Promise.resolve({ status: 204, body: undefined })
    },
    events: () => (async function* () {})(),
    socket: () => Promise.reject(new Error("no socket")),
  }
}

test("a subagent's close leaves the parent's servers; the parent's close undoes what it did", async () => {
  const sent: string[] = []
  const held: string[] = []
  const replaced: string[] = []
  const records = mkdtempSync(join(tmpdir(), "yc-shared-"))
  const deps = {
    transport: () => fakeTransport(sent),
    folder: "/p",
    service: () => "http://s",
    held: (_name: string, problem: string) => held.push(problem),
    replaced: (name: string) => replaced.push(name),
    records,
    live: () => new Set<number>(),
  }
  const servers: McpLaunch[] = [
    { name: "Z", command: "z", args: [], env: {} },
    { name: "X", command: "x", args: [], env: {} },
    { name: "bad", url: "https://h/mcp", headers: { A: "secret-1234" } },
  ]
  const parent = startSharedMcp(deps, servers, { on: false, project: [] })
  await parent.ready
  const child = startSharedMcp(deps, servers, { on: false, project: [] })
  await child.ready
  expect(held[0]).toBe("token … rejected")
  expect(replaced).toEqual(["X", "X"])
  expect(parent.marks()).toEqual({ own: new Set(["X", "Y"]), handed: new Set(["Z", "X"]) })

  sent.length = 0
  await child.close()
  expect(sent).toEqual([])
  await parent.close()
  // X took the place of the user's own X, which only a reload brings back.
  expect(sent).toEqual(["GET /api/session", "POST /api/location/reload"])
  expect(readdirSync(records)).toEqual([])
})

const entry = (handed: string[], replaced: string[] = [], off: string[] = []): Entry => ({
  service: "http://s",
  folder: "/p",
  handed,
  replaced,
  off,
})

test("only what no open session holds or hands now is left over, and a recorded name is never the user's", () => {
  const list = new Map([
    ["A", "connected"],
    ["B", "connected"],
    ["C", "connected"],
    ["X", "connected"],
    ["Y", "disabled"],
    ["Q", "disabled"],
  ])
  const found = {
    live: [entry(["B"], [], ["Q"])],
    gone: [{ ...entry(["A", "B", "C", "X", "gone"], ["X"], ["Y", "Q"]), file: "f" }],
  }
  const ours = { handed: new Set<string>(), off: new Set<string>() }
  expect(sweepOf(found, list, new Set(["C"]), ours, true, new Set())).toEqual({
    remove: ["A"],
    restore: ["X"],
    reconnect: ["Y"],
  })
  // A is a server of the user's config file: a record that names it does not remove it.
  expect(sweepOf(found, list, new Set(["C"]), ours, true, new Set(["A"])).remove).toEqual([])
  expect(sweepOf(found, list, new Set(), { handed: new Set(["A"]), off: new Set(["Y"]) }, false, new Set())).toEqual({
    remove: ["C"],
    restore: ["X"],
    reconnect: [],
  })
  expect(foreignOf(found)).toEqual(new Set(["A", "B", "C", "gone"]))
})

test("a start removes what a YellowCode that is gone left, and keeps what an open one holds", async () => {
  const sent: string[] = []
  const records = mkdtempSync(join(tmpdir(), "yc-shared-"))
  const stored = (pid: number, handed: string[]) =>
    writeFileSync(join(records, `${pid}-x.json`), JSON.stringify({ pid, entries: [entry(handed)] }))
  // X is the user's own: a record naming it is wrong. A record gone a month names a folder no one opens.
  stored(1, ["X", "Z"])
  stored(2, ["Y"])
  stored(3, ["W"])
  const month = Date.now() / 1000 - 31 * 24 * 60 * 60
  utimesSync(join(records, "3-x.json"), month, month)
  const deps = {
    transport: () => fakeTransport(sent, ["Z"]),
    folder: "/p",
    service: () => "http://s",
    held: () => {},
    replaced: () => {},
    records,
    live: () => new Set([2]),
  }
  const sharing = startSharedMcp(deps, [], { on: true, project: [] })
  await sharing.ready
  expect(sent.filter((line) => !line.startsWith("GET"))).toEqual(["DELETE /api/experimental/mcp/Z"])
  expect(readdirSync(records)).toEqual(["2-x.json"])
})

const depsFor = (sent: string[], records: string, live: number[], busy = () => false) => ({
  transport: () => fakeTransport(sent, [], busy),
  folder: "/p",
  service: () => "http://s",
  held: () => {},
  replaced: () => {},
  records,
  live: () => new Set(live),
})
const sharedX: McpLaunch[] = [{ name: "X", command: "x", args: [], env: {} }]
const reloads = (sent: string[]) => sent.filter((line) => line === "POST /api/location/reload").length

test("no reload while another YellowCode holds servers or a turn runs; what it would bring back waits on record", async () => {
  const sent: string[] = []
  const records = mkdtempSync(join(tmpdir(), "yc-shared-"))
  writeFileSync(join(records, "2-x.json"), JSON.stringify({ pid: 2, entries: [entry(["Q"])] }))
  let running = true
  const live = new Set([2])
  const deps = {
    ...depsFor(sent, records, []),
    live: () => live,
    transport: () => fakeTransport(sent, [], () => running),
  }
  const first = startSharedMcp(deps, sharedX, { on: true, project: [] })
  await first.ready
  await first.close()
  expect(reloads(sent)).toBe(0)
  const mine = readdirSync(records).find((name) => name !== "2-x.json") ?? ""
  expect(readFileSync(join(records, mine), "utf8")).toContain('"handed":["X"],"replaced":["X"]')

  // The other YellowCode is gone, and a turn still runs: still no reload.
  live.clear()
  const second = startSharedMcp(deps, [], { on: true, project: [] })
  await second.ready
  expect(reloads(sent)).toBe(0)
  running = false
  await second.close()
  expect(reloads(sent)).toBe(1)
  expect(readdirSync(records)).toEqual([])
})

test("a reload of another YellowCode during a start is not taken for this one's own", async () => {
  const sent: string[] = []
  const records = mkdtempSync(join(tmpdir(), "yc-shared-"))
  const sharing = startSharedMcp(depsFor(sent, records, []), sharedX, { on: true, project: [] })
  await sharing.ready
  const puts = () => sent.filter((line) => line.startsWith("PUT")).length
  expect(puts()).toBe(1)
  sharing.check("reloaded", Date.now() - 60_000)
  sharing.check("reloaded", Date.now() + 1)
  await sharing.close()
  expect(puts()).toBe(2)
})

test("a record folder that cannot be written does not stop a start or a close", async () => {
  const sent: string[] = []
  const records = mkdtempSync(join(tmpdir(), "yc-shared-"))
  writeFileSync(join(records, "1-x.json"), JSON.stringify({ pid: 1, entries: [entry(["X"], ["X"])] }))
  chmodSync(records, 0o500)
  try {
    // The start gives the user's X back, and cannot take the record that is gone off.
    const first = startSharedMcp(depsFor(sent, records, []), [], { on: true, project: [] })
    await first.ready
    expect(reloads(sent)).toBe(1)
    expect(readdirSync(records)).toEqual(["1-x.json"])
    const sharing = startSharedMcp(depsFor(sent, records, []), sharedX, { on: true, project: [] })
    await sharing.ready
    sharing.check("reloaded", Date.now() + 1)
    await sharing.close()
    await first.close()
    expect(sent.filter((line) => line.startsWith("PUT")).length).toBe(2)
  } finally {
    chmodSync(records, 0o700)
  }
})
