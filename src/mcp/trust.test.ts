import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readMcpFile } from "./servers.ts"
import { loadShared, recordTrust, sessionServers, trustState } from "./trust.ts"

test("a project file is trusted only for the servers the user said yes to", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "trust-")))
  const store = join(dir, "trust.json")
  const global = join(dir, "mcp.json")
  const project = join(dir, "project")
  mkdirSync(join(project, "sub"), { recursive: true })
  // The file is looked for up to the git root.
  Bun.spawnSync(["git", "init", "-q"], { cwd: project })
  writeFileSync(global, JSON.stringify({ mcpServers: { g: { command: "${HOME_BIN:-g}" }, x: { command: "global" } } }))
  const projectFile = join(project, ".mcp.json")
  const write = (servers: object) => writeFileSync(projectFile, JSON.stringify({ mcpServers: servers }))
  write({ x: { command: "project" } })

  const names = () =>
    sessionServers(loadShared(join(project, "sub"), store, global), {}).servers.map((s) => `${s.name}:${s.scope}`)
  expect(trustState(readMcpFile(projectFile), store)).toBe("new")
  expect(names()).toEqual(["g:global", "x:global"])

  recordTrust(readMcpFile(projectFile), true, store)
  expect(trustState(readMcpFile(projectFile), store)).toBe("trusted")
  expect(names()).toEqual(["g:global", "x:project"])

  write({ x: { command: "project", args: ["more"] } })
  expect(trustState(readMcpFile(projectFile), store)).toBe("changed")
  expect(names()).toEqual(["g:global", "x:global"])

  recordTrust(readMcpFile(projectFile), false, store)
  expect(trustState(readMcpFile(projectFile), store)).toBe("refused")
})

test("a server that needs an unset variable is held back with its name only", () => {
  const dir = mkdtempSync(join(tmpdir(), "held-"))
  const global = join(dir, "mcp.json")
  writeFileSync(global, JSON.stringify({ mcpServers: { gh: { command: "x", env: { T: "${GITHUB_TOKEN}" } } } }))
  const shared = loadShared(dir, join(dir, "trust.json"), global)
  expect(sessionServers(shared, {})).toEqual({
    servers: [],
    held: [{ name: "gh", scope: "global", problem: "needs $GITHUB_TOKEN" }],
  })
})
