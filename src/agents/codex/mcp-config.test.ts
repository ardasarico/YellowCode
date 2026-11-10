import { expect, test } from "bun:test"
import { ownServers, threadMcp } from "./mcp-config.ts"

const reply = {
  config: { mcp_servers: { X: { env: { TOKEN: "secret" } } } },
  layers: [
    {
      name: { type: "user" },
      config: {
        mcp_servers: {
          X: { command: "own", env: { TOKEN: "secret", KEEP: "mine" }, env_vars: ["HOME"], cwd: "/own" },
          W: { url: "https://own", http_headers: { "X-Key": "secret" }, env_http_headers: { Authorization: "TOKEN" } },
          B: { url: "https://own", bearer_token_env_var: "TOKEN" },
          S: { command: "own" },
          O: { command: "other" },
        },
      },
    },
  ],
}

test("a shared server overrides every field Codex's own of its name would leak, and keeps no value of it", () => {
  const own = ownServers(reply)
  expect(JSON.stringify([...own])).not.toContain("secret")
  const { config, held } = threadMcp(
    [
      { name: "X", command: "npx", args: ["server"], env: { KEEP: "ours" } },
      { name: "W", url: "https://shared", headers: {} },
      { name: "N", command: "new", args: [], env: {} },
    ],
    own,
    { on: true, project: [] },
    "/project",
  )
  expect(held).toEqual([])
  expect(config).toEqual({
    "mcp_servers.X": {
      command: "npx",
      args: ["server"],
      env: { TOKEN: "", KEEP: "ours" },
      cwd: "/project",
      enabled: true,
      env_vars: [],
    },
    "mcp_servers.W": {
      url: "https://shared",
      http_headers: { "X-Key": "" },
      enabled: true,
      env_http_headers: { Authorization: "" },
    },
    "mcp_servers.N": { command: "new", args: [] },
  })
})

test("a server Codex cannot run over its own is held and the name switched off; off leaves only ours", () => {
  const { config, held } = threadMcp(
    [
      { name: "S", url: "https://shared", headers: {} },
      { name: "B", url: "https://shared", headers: {} },
      { name: "E", url: "https://shared", headers: {}, type: "sse" },
    ],
    ownServers(reply),
    { on: false, project: [] },
    "/project",
  )
  expect(held.map((server) => server.name)).toEqual(["S", "B", "E"])
  expect(held[0]?.problem).toBe(
    "Codex has its own S of another kind, so S is off here. Remove it from Codex's config to use the shared one.",
  )
  expect(config).toEqual({
    "mcp_servers.S.enabled": false,
    "mcp_servers.B.enabled": false,
    "mcp_servers.X.enabled": false,
    "mcp_servers.W.enabled": false,
    "mcp_servers.O.enabled": false,
  })
})

test("a shared server over Codex's own tells whether the own one runs another program or url", () => {
  const own = ownServers({
    layers: [
      {
        config: {
          mcp_servers: {
            P: { command: "npx", args: ["-y", "@scope/server@1", "--token", "secret"] },
            Q: { command: "uvx", args: ["other"] },
            R: { url: "https://host/a?key=secret" },
            T: { command: "bun", args: ["one.ts"] },
          },
        },
      },
    ],
  })
  expect(JSON.stringify([...own])).not.toContain("secret")
  const { replaced } = threadMcp(
    [
      { name: "P", command: "/usr/bin/npx", args: ["@scope/server@latest"], env: {} },
      { name: "Q", command: "npx", args: ["other"], env: {} },
      { name: "R", url: "https://host/b", headers: {} },
      { name: "T", command: "bun", args: ["two.ts"], env: {} },
    ],
    own,
    { on: true, project: [] },
    "/project",
  )
  expect(replaced).toEqual([
    { name: "P", different: false },
    { name: "Q", different: true },
    { name: "R", different: true },
    { name: "T", different: null },
  ])
})
