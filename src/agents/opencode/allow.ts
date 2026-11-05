// What YellowCode keeps from opencode's config, provider, model, agent, MCP, skill and plugin answers. The first ones
// echo API keys, headers and MCP environments, so everything not listed here is dropped before any other code sees the
// body: z.object strips unknown keys. The model and settings stages add the fields they read.
import { z } from "zod"
import { rowsOf } from "../../json.ts"
import { log } from "../../log/log.ts"
import type { Transport } from "./transport.ts"
import { answerOf, dataOf } from "./wire/envelope.ts"

const location = z.object({ directory: z.string() })

export const provider = z.object({ id: z.string(), name: z.string(), activation: z.string().optional() })

export const model = z.object({
  id: z.string(),
  modelID: z.string(),
  providerID: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  status: z.string().optional(),
  limit: z.object({ context: z.number(), input: z.number().optional(), output: z.number() }).optional(),
  capabilities: z.object({ input: z.array(z.string()) }).optional(),
  variants: z.array(z.object({ id: z.string() })).optional(),
})

const modelChoice = z.union([
  z.string(),
  z.object({ providerID: z.string(), model: z.string(), variant: z.string().optional() }),
])

// A value of another shape is dropped alone, so it does not take the rest of its document with it.
const field = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined)
const whole = z.number().int()

const rule = z.object({ action: z.string(), resource: z.string(), effect: z.string() })

// The settings /settings shows, and the rules /permissions lists. Providers, MCP servers, agents and the rest stay
// out: they hold keys, headers and environments, or are shown elsewhere. Warming's own prompt is not kept.
export const configInfo = z.object({
  shell: field(z.string()),
  model: field(modelChoice),
  default_agent: field(z.string()),
  websearch: field(z.union([z.literal(false), z.object({ provider: z.string() })])),
  compaction: field(
    z.object({
      auto: field(z.boolean()),
      buffer: field(whole),
      keep: field(z.object({ tokens: field(whole) })),
    }),
  ),
  tool_output: field(z.object({ max_lines: field(whole), max_bytes: field(whole) })),
  media: field(
    z.object({
      image: field(
        z.object({
          auto_resize: field(z.boolean()),
          max_width: field(whole),
          max_height: field(whole),
          max_base64_bytes: field(whole),
        }),
      ),
    }),
  ),
  permissions: field(z.array(rule)),
  policies: field(z.array(rule)),
  watcher: field(z.object({ ignore: field(z.array(z.string())) })),
  worktree: field(z.object({ directory: field(z.string()) })),
  warming: field(z.union([z.boolean(), z.object({ interval: field(z.string()), duration: field(z.string()) })])),
  mcp: field(
    z.object({
      timeout: field(z.object({ startup: field(whole), catalog: field(whole), execution: field(whole) })),
    }),
  ),
})

export const configEntry = z.object({
  type: z.string(),
  path: z.string().optional(),
  info: field(configInfo),
})

export const shellOption = z.object({ path: z.string(), name: z.string(), acceptable: z.boolean() })

// An agent's `request` carries provider settings, headers and bodies, and `system` its prompt; neither is kept. `model`:
// the one it runs while the session has no pick of its own.
export const agentRow = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  model: z.object({ id: z.string(), providerID: z.string(), variant: z.string().optional() }).optional(),
  mode: z.string(),
  hidden: z.boolean().optional(),
  permissions: z.array(rule).optional(),
})

// A server's name and state; a failed one's error can quote its command line, so it is not kept.
export const mcpServer = z.object({
  name: z.string(),
  title: z.string().optional(),
  status: z.object({ status: z.string() }),
})

// A skill's own text is not kept.
export const skillInfo = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  path: z.string(),
})

// Where a plugin comes from and whether it runs; a failed one's error is not kept.
export const pluginInfo = z.object({
  id: z.string().optional(),
  source: z.object({ type: z.string(), target: z.string().optional(), path: z.string().optional() }),
  state: z.object({ status: z.string() }),
})

// The Go allowance's windows; the workspace and its budgets are not kept.
const meter = z.object({ percent: z.number(), limited: z.boolean(), resetsAt: z.number() })
export const usageLimits = z.object({
  go: z.object({ rolling: meter, weekly: meter, monthly: meter }).optional(),
})

const failure = z.object({ _tag: z.string(), message: z.string().optional() })

const list = (row: z.ZodType) => (body: unknown) => {
  const rows = Array.isArray(body) ? body : []
  return rowsOf(row, rows).rows
}

const wrapped = (row: z.ZodType, many: boolean) => (body: unknown) => {
  const parsed = z.object({ location: location.optional(), data: z.unknown() }).safeParse(body)
  if (!parsed.success) return undefined
  const data = many ? list(row)(parsed.data.data) : row.nullable().safeParse(parsed.data.data).data
  return { ...(parsed.data.location ? { location: parsed.data.location } : {}), data }
}

const PROJECTIONS: [RegExp, (body: unknown) => unknown][] = [
  [/^\/api\/config$/, list(configEntry)],
  [/^\/api\/config\/shell$/, list(shellOption)],
  [/^\/api\/provider$/, wrapped(provider, true)],
  [/^\/api\/provider\/[^/]+$/, wrapped(provider, false)],
  [/^\/api\/model$/, wrapped(model, true)],
  [/^\/api\/model\/default$/, wrapped(model, false)],
  [/^\/api\/agent$/, wrapped(agentRow, true)],
  [/^\/api\/mcp$/, wrapped(mcpServer, true)],
  [/^\/api\/skill$/, wrapped(skillInfo, true)],
  [/^\/api\/plugin$/, wrapped(pluginInfo, true)],
  [/^\/api\/experimental\/usage\/limits$/, wrapped(usageLimits, false)],
]

// The projection for a GET answer of `path`, or undefined when the path needs none. An error answer keeps only its
// tag and message.
export function allowlistFor(path: string): ((body: unknown, status: number) => unknown) | undefined {
  const project = PROJECTIONS.find(([pattern]) => pattern.test(path))?.[1]
  if (!project) return undefined
  return (body, status) => (status >= 200 && status < 300 ? project(body) : failure.safeParse(body).data)
}

// The `data` of a GET answer (the answer itself where it is a bare list), kept through the allowlist; null, logged as
// `what`, when opencode did not give it.
// Paths that failed last time: a failure that repeats, such as the limits read after every turn, is logged once.
const failing = new Set<string>()

export async function readAllowed(transport: Transport, path: string, what: string): Promise<unknown> {
  const reply = await transport.request({ method: "GET", path }).catch(() => null)
  const kept = reply ? { status: reply.status, body: allowlistFor(path)?.(reply.body, reply.status) } : null
  const answer = kept ? answerOf(kept, z.union([z.array(z.unknown()), dataOf(z.unknown())]), path) : null
  if (answer?.kind === "ok") {
    failing.delete(path)
    return Array.isArray(answer.value) ? answer.value : answer.value.data
  }
  if (!failing.has(path))
    log.warn(`opencode: could not read ${what} (${answer?.kind === "error" ? answer.status : "no answer"})`)
  failing.add(path)
  return null
}
