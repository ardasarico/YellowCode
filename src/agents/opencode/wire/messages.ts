// The entries of `GET /api/session/{id}/message`, newest first.
import { z } from "zod"
import { location } from "./envelope.ts"
import { modelRef, outcome, structuredError, tokens } from "./session.ts"

const time = z.looseObject({ created: z.number(), completed: z.number().optional() })

const entry = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.looseObject({ id: z.string(), time, type: z.literal(type), ...shape })

// What opencode adds later stays readable as `unknown` with its original type.
function withUnknown<T extends z.ZodType>(known: T, types: readonly string[]) {
  return z.union([
    known,
    z
      .looseObject({ type: z.string() })
      .refine((value) => !types.includes(value.type))
      .transform((value) => ({ type: "unknown" as const, originalType: value.type })),
  ])
}

const toolContent = withUnknown(z.looseObject({ type: z.literal("text"), text: z.string() }), ["text"])

const toolState = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("streaming"), input: z.string() }),
  z.looseObject({ status: z.literal("running"), input: z.record(z.string(), z.unknown()), metadata: z.unknown() }),
  z.looseObject({
    status: z.literal("completed"),
    input: z.record(z.string(), z.unknown()),
    content: z.array(toolContent),
    metadata: z.unknown().optional(),
  }),
  z.looseObject({
    status: z.literal("error"),
    input: z.record(z.string(), z.unknown()),
    error: structuredError,
    content: z.array(toolContent).optional(),
    metadata: z.unknown().optional(),
  }),
])

// What a user message carries besides its text: files opencode stored inline, images among them.
export const userFiles = z.array(
  z.looseObject({ mime: z.string(), data: z.string().optional(), name: z.string().optional() }),
)
export const userPayload = z.looseObject({ text: z.string(), files: userFiles.optional() })

const PARTS = ["text", "reasoning", "tool"] as const
export const assistantPart = withUnknown(
  z.discriminatedUnion("type", [
    z.looseObject({ type: z.literal("text"), text: z.string() }),
    z.looseObject({ type: z.literal("reasoning"), text: z.string() }),
    z.looseObject({
      type: z.literal("tool"),
      id: z.string(),
      name: z.string(),
      executed: z.boolean().optional(),
      state: toolState,
      time,
    }),
  ]),
  PARTS,
)

const TYPES = [
  "user",
  "assistant",
  "idle",
  "synthetic",
  "system",
  "agent-switched",
  "model-switched",
  "location-switched",
  "compaction",
  "shell",
  "skill",
] as const

export const message = withUnknown(
  z.discriminatedUnion("type", [
    entry("user", { text: z.string(), files: userFiles.optional() }),
    entry("assistant", {
      agent: z.string(),
      model: modelRef,
      content: z.array(assistantPart),
      finish: z.string().optional(),
      cost: z.number().optional(),
      tokens: tokens.optional(),
      snapshot: z
        .looseObject({
          start: z.string().optional(),
          end: z.string().optional(),
          files: z.array(z.string()).optional(),
        })
        .optional(),
      error: structuredError.optional(),
    }),
    entry("idle", { outcome, error: structuredError.optional() }),
    entry("synthetic", { text: z.string() }),
    entry("system", { text: z.string() }),
    entry("agent-switched", { agent: z.string(), previous: z.string().optional() }),
    entry("model-switched", { model: modelRef, previous: modelRef.optional() }),
    entry("location-switched", { location }),
    entry("compaction", {
      status: z.enum(["running", "completed", "failed"]),
      reason: z.enum(["auto", "manual"]),
      summary: z.string().optional(),
      tokens: tokens.optional(),
      error: structuredError.optional(),
    }),
    entry("shell", { shellID: z.string(), command: z.string(), status: z.string(), exit: z.unknown().optional() }),
    entry("skill", { skill: z.string(), name: z.string(), text: z.string() }),
  ]),
  TYPES,
)

export type Message = z.output<typeof message>
