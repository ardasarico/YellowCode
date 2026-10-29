import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { allowlistFor } from "./allow.ts"
import { MOCK_KEY, secretsIn } from "./fixture.ts"

const DIR = join(import.meta.dir, "..", "..", "..", "fixtures", "opencode")
const line = (value: unknown) => JSON.stringify({ kind: "http", response: value })

test("no opencode fixture holds a secret or the home folder", () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith(".jsonl"))
  expect(files.length).toBeGreaterThan(0)
  for (const name of files)
    expect([name, secretsIn(readFileSync(join(DIR, name), "utf8"), [homedir()])]).toEqual([name, []])
})

test("the scan finds a planted key, auth header or provider secret", () => {
  expect(secretsIn(line({ note: MOCK_KEY }))).not.toEqual([])
  expect(secretsIn(line({ note: "the service password" }), ["the service password"])).not.toEqual([])
  expect(secretsIn(line({ headers: { Authorization: "Basic x" } }))).not.toEqual([])
  expect(secretsIn(line({ data: { providers: { a: { settings: { apiKey: "x" } } } } }))).not.toEqual([])
  expect(secretsIn(line({ data: { mcp: { servers: { s: { environment: { TOKEN: "x" } } } } } }))).not.toEqual([])
  expect(secretsIn(line({ data: [{ id: "build", request: { headers: { "x-agent": "v" } } }] }))).not.toEqual([])
  expect(secretsIn(line({ text: "token sk-live-abcdef123" }))).not.toEqual([])
  expect(secretsIn(line({ text: "task-runner says hi", providerID: "anthropic" }))).toEqual([])
})

test("config, provider and model answers keep only allowlisted fields", () => {
  const secret = { apiKey: MOCK_KEY, baseURL: "http://127.0.0.1:1" }
  const headers = { "x-api-key": MOCK_KEY }
  const provider = { id: "anthropic", name: "Anthropic", activation: "enabled", settings: secret, headers }
  const model = {
    id: "opus",
    modelID: "opus",
    providerID: "anthropic",
    name: "Opus",
    settings: secret,
    headers,
    variants: [{ id: "high", headers, settings: secret }],
    capabilities: { tools: true, input: ["text", "image"], output: ["text"], headers },
    limit: { context: 200000, output: 32000 },
  }
  const config = [
    {
      type: "document",
      path: "/x/opencode.json",
      info: {
        shell: "/bin/zsh",
        providers: { anthropic: { settings: secret, headers } },
        mcp: { servers: { s: { environment: { TOKEN: MOCK_KEY }, headers } } },
      },
    },
  ]
  const answers: [string, unknown][] = [
    ["/api/config", config],
    ["/api/provider", { location: { directory: "/x" }, data: [provider] }],
    ["/api/provider/anthropic", { location: { directory: "/x" }, data: provider }],
    ["/api/model", { location: { directory: "/x" }, data: [model] }],
    ["/api/model/default", { location: { directory: "/x" }, data: model }],
  ]
  for (const [path, body] of answers) {
    const kept = JSON.stringify(allowlistFor(path)?.(body, 200))
    expect([path, secretsIn(kept), kept.includes("baseURL")]).toEqual([path, [], false])
  }
  expect(allowlistFor("/api/model")?.({ _tag: "NotFound", message: "no", headers }, 404)).toEqual({
    _tag: "NotFound",
    message: "no",
  })
  expect(allowlistFor("/api/model")?.({ data: [model] }, 200)).toEqual({
    data: [
      {
        id: "opus",
        modelID: "opus",
        providerID: "anthropic",
        name: "Opus",
        capabilities: { input: ["text", "image"] },
        variants: [{ id: "high" }],
        limit: { context: 200000, output: 32000 },
      },
    ],
  })
})
