import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { secretsIn } from "./fixture.ts"

const DIR = join(import.meta.dir, "..", "..", "..", "fixtures", "codex")
const line = (value: unknown) => JSON.stringify({ kind: "in", t: 0, after: 0, msg: { id: 1, result: value } })

test("no Codex fixture holds a secret, the home folder or the user's name", () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith(".jsonl"))
  expect(files.length).toBeGreaterThan(0)
  for (const name of files)
    expect([name, secretsIn(readFileSync(join(DIR, name), "utf8"), [homedir(), userInfo().username])]).toEqual([
      name,
      [],
    ])
})

test("the scan finds a planted email, token, provider setting or MCP secret", () => {
  expect(secretsIn(line({ account: { type: "chatgpt", plan: "plus" }, note: "someone@example.com" }))).not.toEqual([])
  expect(secretsIn(line({ text: "token sk-live-abcdef123" }))).not.toEqual([])
  expect(secretsIn(line({ access_token: "abc" }))).not.toEqual([])
  expect(secretsIn(line({ config: { model_providers: { mock: { name: "Mock", base_url: "x" } } } }))).not.toEqual([])
  expect(secretsIn(line({ config: { mcp_servers: { s: { command: "x", env: { KEY: "v" } } } } }))).not.toEqual([])
  expect(secretsIn(line({ headers: { Authorization: "Bearer x" } }))).not.toEqual([])
  expect(
    secretsIn(
      line({
        requiresOpenaiAuth: false,
        tokenUsage: { inputTokens: 1200 },
        author: "test@yellowcode.invalid",
        authStatus: "notLoggedIn",
        config: { model_providers: { mock: { name: "Mock" } } },
      }),
    ),
  ).toEqual([])
})
