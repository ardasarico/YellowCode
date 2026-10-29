import { z } from "zod"
import { location } from "./envelope.ts"

export const tokens = z.looseObject({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache: z.looseObject({ read: z.number(), write: z.number() }),
})

export const modelRef = z.looseObject({ id: z.string(), providerID: z.string(), variant: z.string().optional() })

export const outcome = z.enum(["succeeded", "failed", "interrupted"])

export const structuredError = z.looseObject({
  type: z.string(),
  message: z.string(),
  status: z.number().optional(),
  retryAfterMs: z.number().optional(),
})

export const fileDiff = z.looseObject({
  file: z.string(),
  patch: z.string().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  status: z.string().optional(),
})

export const revert = z.looseObject({
  messageID: z.string(),
  snapshot: z.string().optional(),
  files: z.array(fileDiff).optional(),
})

// A permission rule: the last one whose action matches decides.
export const rule = z.looseObject({ action: z.string(), resource: z.string(), effect: z.string() })

export type Rule = z.output<typeof rule>

// opencode's patterns: `*` stands for any run of characters.
const escaped = (text: string) => text.replaceAll(/[\\^$.|?+()[\]{}]/g, String.raw`\$&`)
export const matches = (pattern: string, value: string) =>
  new RegExp(`^${pattern.split("*").map(escaped).join(".*")}$`, "s").test(value)

// `title` is missing until opencode names the session. `permissions` are the session's own rules.
export const session = z.looseObject({
  id: z.string(),
  projectID: z.string(),
  parentID: z.string().optional(),
  fork: z
    .looseObject({
      sessionID: z.string(),
      boundary: z.looseObject({ type: z.enum(["before", "through"]), messageID: z.string() }),
    })
    .optional(),
  agent: z.string().optional(),
  model: modelRef.optional(),
  cost: z.number(),
  tokens,
  outcome: outcome.optional(),
  time: z.looseObject({ created: z.number(), updated: z.number(), archived: z.number().optional() }),
  title: z.string().optional(),
  subpath: z.string().optional(),
  revert: revert.optional(),
  permissions: z.array(rule).optional(),
  location,
})

export type Session = z.output<typeof session>
