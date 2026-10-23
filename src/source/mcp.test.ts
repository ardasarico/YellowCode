import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { mcpServers } from "./mcp.ts"

test("server rows keep states, errors and tool names, and drop everything in a config that can hold a key", () => {
  const servers = mcpServers([
    {
      name: "echo",
      status: "connected",
      serverInfo: { name: "echo", version: "1.0.0" },
      config: { type: "stdio", command: "bun", args: ["/tmp/echo-mcp.ts", "--token", "secret-arg"] },
      scope: "project",
      source: "project",
      tools: [{ name: "echo", annotations: {} }],
    },
    {
      name: "docs",
      status: "connected",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@scope/docs-mcp@latest", "--api-key", "secret-arg"],
        env: { API_KEY: "secret-env" },
      },
      scope: "user",
    },
    {
      name: "runner",
      status: "pending",
      config: { command: "uvx", args: ["--from", "git+https://secret-git@x/y", "z"] },
    },
    {
      name: "gh",
      status: "failed",
      error: 'Executable not found in $PATH: "npx -y gh-mcp --token secret-cmd"',
      config: { type: "stdio", command: "npx -y gh-mcp --token secret-cmd" },
    },
    {
      name: "broken-http",
      status: "failed",
      error: "ECONNREFUSED: Unable to connect. Is the computer able to access the url?",
      config: { type: "http", url: "https://user:secret-pass@mcp.example.com/s/secret-path/mcp?key=secret-query#x" },
      headers: { Authorization: "secret-header" },
      scope: "dynamic",
      source: "dynamic",
    },
    {
      name: "oauth",
      status: "failed",
      error:
        "OAuthError \u001b[31mdialing https://mcp.example.com/s/secret-path?key=secret-error (invalid_target)\u0007",
      config: { type: "http", url: "https://mcp.example.com/mcp?key=secret-error" },
    },
    {
      name: "zap",
      status: "failed",
      error: "TypeError dialing http://user:secret-user@127.0.0.1:9[redacted]?api_key=REDACTED (ECONNREFUSED)",
    },
    {
      name: "bare",
      status: "failed",
      config: { type: "http", url: "secret-user:secret-pass@mcp.example.com/mcp" },
    },
    { name: "odd", status: 3 },
  ])

  expect(servers.map(({ name, status, error, tools }) => [name, status, error, tools])).toEqual([
    ["echo", "connected", null, ["echo"]],
    ["docs", "connected", null, null],
    ["runner", "pending", null, null],
    ["gh", "failed", 'Executable not found in $PATH: "npx"', null],
    ["broken-http", "failed", "ECONNREFUSED: Unable to connect. Is the computer able to access the url?", null],
    ["oauth", "failed", "OAuthError dialing https://mcp.example.com (invalid_target)", null],
    ["zap", "failed", "TypeError dialing http://127.0.0.1:9 (ECONNREFUSED)", null],
    ["bare", "failed", null, null],
  ])
  expect(servers.map((server) => server.config)).toEqual([
    { command: "bun", package: null },
    { command: "npx", package: "@scope/docs-mcp@latest" },
    { command: "uvx", package: null },
    { command: "npx", package: null },
    { url: "https://mcp.example.com" },
    { url: "https://mcp.example.com" },
    null,
    null,
  ])
  expect(JSON.stringify(servers)).not.toContain("secret")
})

const failed = (name: string, command: string, error = `Executable not found in $PATH: "${command}"`) => ({
  name,
  status: "failed",
  error,
  config: { command },
})

test("a command string shows only its program, also inside the error, and a cut url only its origin", () => {
  const spaced = join(mkdtempSync(join(tmpdir(), "yc-mcp-")), "My App", "server")
  mkdirSync(dirname(spaced), { recursive: true })
  writeFileSync(spaced, "")
  const servers = mcpServers([
    failed("envy", "GITHUB_TOKEN=secret-env npx -y gh-mcp"),
    failed("tabs", "npx\t-y\tgh-mcp\t--token\tsecret-tab"),
    failed("spaced", spaced),
    failed("cut", "bun", "TypeError dialing http://127.0.0.1:9[redacted] (ECONNREFUSED)"),
  ])
  expect(servers.map(({ error, config }) => [error, config])).toEqual([
    ['Executable not found in $PATH: "npx"', { command: "npx", package: null }],
    ['Executable not found in $PATH: "npx"', { command: "npx", package: null }],
    ['Executable not found in $PATH: "server"', { command: "server", package: null }],
    ["TypeError dialing http://127.0.0.1:9 (ECONNREFUSED)", { command: "bun", package: null }],
  ])
  expect(JSON.stringify(servers)).not.toContain("secret")
})
