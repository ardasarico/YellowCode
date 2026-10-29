// The format of fixtures/opencode/*.jsonl, written by tools/opencode/record.ts and read by the replay transport.
import { z } from "zod"
import { parseJson } from "../../json.ts"

// The key the isolated config gives the mock provider. A fixture that contains it leaked a secret.
export const MOCK_KEY = "sk-ant-yc-mock-0000000000000000"

const method = z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"])

const metaLine = z.looseObject({
  kind: z.literal("meta"),
  scenario: z.string(),
  opencode: z.string(),
  root: z.string(),
})
const intentLine = z.looseObject({
  kind: z.literal("intent"),
  n: z.number(),
  intent: z.string(),
  args: z.unknown().optional(),
})
// `n` is the exchange's place among the steps: exchanges in the order they completed and socket frames sent.
// `stream` counts the event streams opened before it (0 for the first); a reconnect opens the next.
const httpLine = z.looseObject({
  kind: z.literal("http"),
  n: z.number(),
  stream: z.number().optional(),
  t: z.number(),
  method,
  path: z.string(),
  query: z.record(z.string(), z.string()),
  body: z.unknown().optional(),
  status: z.number(),
  response: z.unknown().optional(),
})
// `after` is how many steps had happened when the event arrived, `stream` which event stream it came on.
const sseLine = z.looseObject({
  kind: z.literal("sse"),
  t: z.number(),
  after: z.number(),
  stream: z.number().optional(),
  event: z.unknown(),
})
// A websocket frame (client-mcp), `in` from opencode or `out` to it; `in` frames are placed like events. `conn` counts
// the sockets of that name opened before it (0 for the first).
const wsLine = z.looseObject({
  kind: z.literal("ws"),
  t: z.number(),
  after: z.number(),
  socket: z.string(),
  conn: z.number().optional(),
  dir: z.enum(["in", "out"]),
  frame: z.unknown(),
})

// The reader closed event stream `stream` itself; it did not break. Replay keeps it open until its reader closes it.
const closedLine = z.looseObject({
  kind: z.literal("closed"),
  t: z.number(),
  after: z.number(),
  stream: z.number(),
})

const line = z.discriminatedUnion("kind", [metaLine, intentLine, httpLine, sseLine, wsLine, closedLine])

export type FixtureLine = z.output<typeof line>
export type HttpLine = z.output<typeof httpLine>
export type SseLine = z.output<typeof sseLine>
export type WsLine = z.output<typeof wsLine>
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

const SECRET_KEYS = new Set(["apiKey", "headers", "environment"])
const SECRET_PARENTS = new Set(["providers", "provider", "mcp", "agents", "agent", "request"])

function secretKeysIn(value: unknown, under: boolean, path: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => secretKeysIn(item, under, `${path}[${index}]`, found))
    return
  }
  if (typeof value !== "object" || value === null) return
  for (const [key, inner] of Object.entries(value)) {
    if (key === "password" || (under && SECRET_KEYS.has(key))) found.push(`key ${path}.${key}`)
    secretKeysIn(inner, under || SECRET_PARENTS.has(key), `${path}.${key}`, found)
  }
}

// What in a fixture looks like a secret or a machine-specific value. `known` are exact values that must not appear
// (the mock key, the service password, the home folder).
export function secretsIn(text: string, known: readonly string[] = []): string[] {
  const found: string[] = []
  for (const value of [MOCK_KEY, ...known]) if (value !== "" && text.includes(value)) found.push("a known secret value")
  if (/authorization/i.test(text)) found.push("authorization")
  if (/\bsk-[A-Za-z0-9_-]{6,}/.test(text)) found.push("an sk- token")
  text.split("\n").forEach((row, index) => {
    const json = parseJson(row)
    if (json.ok) secretKeysIn(json.value, false, `line ${index + 1}`, found)
  })
  return found
}
