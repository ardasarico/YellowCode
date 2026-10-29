// `ThreadItem`, the parts of a turn. Objects are loose and statuses plain strings, so what Codex adds later passes;
// an item type not listed here stays readable as `unknown` with its original type.
import { z } from "zod"

const item = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.looseObject({ type: z.literal(type), id: z.string(), ...shape })

const nullish = <T extends z.ZodType>(schema: T) => schema.nullable().optional()

export const userInput = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  name: z.string().optional(),
})

// read {name, path}, listFiles {path}, search {query, path}, unknown: each with the command it came from.
export const commandAction = z.looseObject({
  type: z.string(),
  command: z.string(),
  name: z.string().optional(),
  path: nullish(z.string()),
  query: nullish(z.string()),
})

export const fileUpdateChange = z.looseObject({
  path: z.string(),
  // add, delete, or update with `move_path` set on a rename.
  kind: z.looseObject({ type: z.string(), move_path: nullish(z.string()) }),
  diff: z.string(),
})

const KNOWN = [
  item("userMessage", { clientId: nullish(z.string()), content: z.array(userInput) }),
  item("hookPrompt", { fragments: z.array(z.looseObject({ text: z.string() })) }),
  item("agentMessage", { text: z.string(), phase: nullish(z.string()), delivery: nullish(z.string()) }),
  item("functionCallOutput", { name: z.string(), namespace: nullish(z.string()), output: z.unknown() }),
  item("plan", { text: z.string() }),
  item("reasoning", { summary: z.array(z.string()), content: z.array(z.string()) }),
  item("commandExecution", {
    command: z.string(),
    cwd: z.string(),
    processId: nullish(z.string()),
    source: nullish(z.string()),
    status: z.string(),
    commandActions: z.array(commandAction),
    aggregatedOutput: nullish(z.string()),
    exitCode: nullish(z.number()),
    durationMs: nullish(z.number()),
  }),
  item("fileChange", { changes: z.array(fileUpdateChange), status: z.string() }),
  item("mcpToolCall", {
    server: z.string(),
    tool: z.string(),
    status: z.string(),
    arguments: z.unknown(),
    result: nullish(z.looseObject({ content: z.array(z.unknown()) })),
    error: nullish(z.looseObject({ message: z.string() })),
    durationMs: nullish(z.number()),
  }),
  item("dynamicToolCall", {
    namespace: nullish(z.string()),
    tool: z.string(),
    arguments: z.unknown(),
    status: z.string(),
    contentItems: nullish(z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))),
    success: nullish(z.boolean()),
    durationMs: nullish(z.number()),
  }),
  item("collabAgentToolCall", {
    tool: z.string(),
    status: z.string(),
    senderThreadId: z.string(),
    receiverThreadIds: z.array(z.string()),
    prompt: nullish(z.string()),
    model: nullish(z.string()),
    agentsStates: z.record(z.string(), z.looseObject({ status: z.string(), message: nullish(z.string()) })),
  }),
  item("subAgentActivity", { kind: z.string(), agentThreadId: z.string(), agentPath: z.string() }),
  item("webSearch", { query: z.string(), action: z.unknown().optional(), results: nullish(z.array(z.unknown())) }),
  item("imageView", { path: z.string() }),
  item("sleep", { durationMs: z.number() }),
  item("imageGeneration", { status: z.string(), revisedPrompt: nullish(z.string()), savedPath: z.string().optional() }),
  item("enteredReviewMode", { review: z.string() }),
  item("exitedReviewMode", { review: z.string() }),
  item("contextCompaction", {}),
] as const

const TYPES: ReadonlySet<string> = new Set(KNOWN.map((schema) => schema.shape.type.value))

export const threadItem = z.union([
  z.discriminatedUnion("type", KNOWN),
  z
    .looseObject({ type: z.string(), id: z.string() })
    .refine((value) => !TYPES.has(value.type))
    .transform((value) => ({ type: "unknown" as const, id: value.id, originalType: value.type })),
])

export type ThreadItem = z.output<typeof threadItem>
