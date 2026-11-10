import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseJson } from "../json.ts"
import { ancestorNames, expandEntry, mergeServers, readMcpFile, writeServer } from "./servers.ts"

const dir = mkdtempSync(join(tmpdir(), "mcp-"))
function file(name: string, json: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, typeof json === "string" ? json : JSON.stringify(json))
  return path
}

test("a bad name or entry is one problem, the rest of the file is read", () => {
  const read = readMcpFile(
    file("a.json", {
      mcpServers: {
        "my.server": { command: "x" },
        "yellowcode-agents": { command: "x" },
        "mod-x": { command: "x" },
        broken: { type: "http" },
        ok: { command: "npx", args: ["-y", "s"], extra: true },
      },
    }),
  )
  expect(Object.keys(read.servers)).toEqual(["ok"])
  expect(read.problems).toHaveLength(4)
  expect(readMcpFile(file("b.json", "{ nope")).problems).toEqual([`${join(dir, "b.json")} is not valid JSON`])
})

test("a project entry replaces the global one whole", () => {
  const global = readMcpFile(
    file("g.json", { mcpServers: { a: { command: "x", env: { K: "v" } }, b: { type: "sse", url: "u" } } }),
  )
  const project = readMcpFile(file("p.json", { mcpServers: { a: { command: "y" } } }))
  expect(mergeServers(global, project)).toEqual([
    { name: "a", scope: "project", entry: { command: "y" } },
    { name: "b", scope: "global", entry: { type: "sse", url: "u" } },
  ])
})

test("variables expand with defaults, and an unset one holds the entry back", () => {
  const env = { TOKEN: "t", EMPTY: "" }
  expect(
    expandEntry({ type: "http", url: "${HOST:-h}/x", headers: { Authorization: "Bearer ${TOKEN}" } }, env),
  ).toEqual({ ok: true, value: { type: "http", url: "h/x", headers: { Authorization: "Bearer t" } } })
  expect(expandEntry({ command: "x", args: ["${EMPTY:-d}", "${EMPTY}"] }, env)).toEqual({
    ok: true,
    value: { command: "x", args: ["d", ""] },
  })
  expect(expandEntry({ command: "x", env: { A: "${GITHUB_TOKEN}" } }, env)).toEqual({
    ok: false,
    missing: ["GITHUB_TOKEN"],
  })
})

test("a rewrite keeps the other keys and entries", () => {
  const path = file("w.json", { other: 1, mcpServers: { keep: { command: "x", note: "mine" } } })
  expect(writeServer(path, "new", { command: "y" })).toMatchObject({ ok: true, replaced: false })
  expect(writeServer(path, "new", { command: "z" })).toMatchObject({ ok: true, replaced: true })
  const text = readFileSync(path, "utf8")
  expect(parseJson(text)).toEqual({
    ok: true,
    value: { other: 1, mcpServers: { keep: { command: "x", note: "mine" }, new: { command: "z" } } },
  })
  expect(text.endsWith("}\n")).toBe(true)
  expect(writeServer(file("bad.json", "{"), "x", { command: "y" }).ok).toBe(false)
})

test("only a regular file of at most 1 MB is read", () => {
  const device = join(dir, "device.json")
  symlinkSync("/dev/zero", device)
  expect(readMcpFile(device).problems).toEqual([`${device} is not a file`])
  const big = file("big.json", `{"mcpServers":{},"x":"${"a".repeat(1024 * 1024)}"}`)
  expect(readMcpFile(big).problems).toEqual([`${big} is larger than 1 MB`])
})

test("Claude Code's names come from every .mcp.json up the tree, even the ones YellowCode cannot use", () => {
  const top = mkdtempSync(join(tmpdir(), "mcp-up-"))
  const project = join(top, "repo", "sub")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(top, ".mcp.json"), JSON.stringify({ mcpServers: { "my.server": 1, parent: {} } }))
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { near: { command: "x" } } }))
  const names = ancestorNames(project)
  for (const name of ["near", "my.server", "parent"]) expect(names).toContain(name)
  // Claude Code may still run what such a file names.
  writeFileSync(join(top, "repo", ".mcp.json"), "{")
  expect(ancestorNames(project)).toBeNull()
})
