// What a thread runs with, and the lists the mode and model pickers read. Loose objects: fields Codex adds later pass.
import { z } from "zod"

const nullish = <T extends z.ZodType>(schema: T) => schema.nullable().optional()

export const collaborationMode = z.looseObject({
  // plan or default.
  mode: z.string(),
  settings: z.looseObject({ model: z.string(), reasoning_effort: nullish(z.string()) }),
})

export const activeProfile = z.looseObject({ id: z.string() })

// thread/settings/updated: the whole settings after any change, ours or another client's.
export const threadSettings = z.looseObject({
  approvalPolicy: z.unknown(),
  sandboxPolicy: z.unknown(),
  activePermissionProfile: nullish(activeProfile),
  model: z.string(),
  modelProvider: z.string(),
  effort: nullish(z.string()),
  summary: nullish(z.string()),
  collaborationMode: nullish(collaborationMode),
})

export const collaborationModes = z.looseObject({
  data: z.array(z.looseObject({ name: z.string(), mode: nullish(z.string()) })),
})

export const permissionProfiles = z.looseObject({
  data: z.array(z.looseObject({ id: z.string(), description: nullish(z.string()), allowed: z.boolean() })),
  nextCursor: nullish(z.string()),
})

export const model = z.looseObject({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  hidden: z.boolean(),
  supportedReasoningEfforts: z.array(z.looseObject({ reasoningEffort: z.string(), description: z.string() })),
  defaultReasoningEffort: z.string(),
  inputModalities: z.array(z.string()),
  isDefault: z.boolean(),
})

export const turnSettingsResult = z.looseObject({ status: z.string() })

export type ThreadSettings = z.output<typeof threadSettings>
export type CodexModel = z.output<typeof model>

// config/value/write: the written file's new version, and the layer that still wins over it, if any.
export const configWriteResult = z.looseObject({
  status: z.string(),
  version: z.string(),
  overriddenMetadata: nullish(
    z.looseObject({ overridingLayer: z.looseObject({ name: z.looseObject({ type: z.string() }) }) }),
  ),
})
