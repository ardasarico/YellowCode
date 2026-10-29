// The format of fixtures/codex/*.jsonl, written by tools/codex/record.ts and read by the replay transport.
import { z } from "zod"
import { parseJson } from "../../json.ts"

const metaLine = z.looseObject({
  kind: z.literal("meta"),
  scenario: z.string(),
  codex: z.string(),
  root: z.string(),
})
const intentLine = z.looseObject({
  kind: z.literal("intent"),
  n: z.number(),
  intent: z.string(),
  args: z.unknown().optional(),
})
// `c` numbers the app-servers of a recording in the order they were spawned; left out, it is the first. `n` and
// `after` count per app-server.
const connection = z.number().optional()
// A message we sent; `n` counts the messages sent before it.
const outLine = z.looseObject({ kind: z.literal("out"), c: connection, n: z.number(), t: z.number(), msg: z.unknown() })
// A message from app-server; `after` is how many messages we had sent when it arrived.
const inLine = z.looseObject({
  kind: z.literal("in"),
  c: connection,
  t: z.number(),
  after: z.number(),
  msg: z.unknown(),
})
// app-server exited on its own during the recording.
const exitLine = z.looseObject({
  kind: z.literal("exit"),
  c: connection,
  t: z.number(),
  after: z.number(),
  code: z.number().nullable(),
  signal: z.string().nullable(),
})

const line = z.discriminatedUnion("kind", [metaLine, intentLine, outLine, inLine, exitLine])

export type FixtureLine = z.output<typeof line>
export type OutLine = z.output<typeof outLine>
export type InLine = z.output<typeof inLine>
export type ExitLine = z.output<typeof exitLine>
export type Fixture = { meta: z.output<typeof metaLine>; lines: FixtureLine[] }

export function readFixture(text: string): Fixture {
  const lines = text
    .split("\n")
    .filter((row) => row.trim() !== "")
    .map((row, index) => {
      const json = parseJson(row)
      const parsed = json.ok ? line.safeParse(json.value) : undefined
      if (!parsed?.success) throw new Error(`fixture line ${index + 1} is not a fixture line`)
      return parsed.data
    })
  const meta = lines[0]
  if (meta?.kind !== "meta") throw new Error("a fixture starts with its meta line")
  return { meta, lines }
}

// A string under one of these keys is a credential or a personal detail; an MCP server's authStatus only names its kind
// of sign-in.
const SECRET_KEY = /email|auth(?!or|Status$)|token|password|secret|api_?key|bearer/i
const MCP_SECRETS = new Set(["env", "headers", "http_headers", "env_http_headers", "bearer_token"])
const EMAIL = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.(?!invalid\b)[a-z]{2,}/i

function secretKeysIn(value: unknown, parent: string, path: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => secretKeysIn(item, parent, `${path}[${index}]`, found))
    return
  }
  if (typeof value !== "object" || value === null) return
  for (const [key, inner] of Object.entries(value)) {
    const at = `${path}.${key}`
    if (SECRET_KEY.test(key) && typeof inner === "string" && inner !== "") found.push(`key ${at}`)
    if (parent === "provider" && key !== "name") found.push(`key ${at}`)
    if (parent === "mcp" && MCP_SECRETS.has(key)) found.push(`key ${at}`)
    const under =
      parent === "model_providers"
        ? "provider"
        : parent === "mcp_servers"
          ? "mcp"
          : key === "model_providers" || key === "mcp_servers"
            ? key
            : ""
    secretKeysIn(inner, under, at, found)
  }
}

// What in a fixture looks like a secret or a machine-specific value. `known` are exact values that must not appear
// (the home folder, the user's name).
export function secretsIn(text: string, known: readonly string[] = []): string[] {
  const found: string[] = []
  for (const value of known) if (value !== "" && text.includes(value)) found.push("a known value")
  if (/authorization/i.test(text)) found.push("authorization")
  if (/\bsk-[A-Za-z0-9_-]{6,}/.test(text)) found.push("an sk- token")
  if (EMAIL.test(text)) found.push("an email address")
  text.split("\n").forEach((row, index) => {
    const json = parseJson(row)
    if (json.ok) secretKeysIn(json.value, "", `line ${index + 1}`, found)
  })
  return found
}
