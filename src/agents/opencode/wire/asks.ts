// What opencode asks the user: a permission request and a form, as `permission.asked` / `form.created` carry them and
// as `GET /session/{id}/permission` and `/form` list the pending ones.
import { z } from "zod"

export const permissionRequest = z.looseObject({
  id: z.string(),
  sessionID: z.string(),
  action: z.string(),
  resources: z.array(z.string()),
  save: z.array(z.string()).optional(),
  source: z.looseObject({ type: z.string(), messageID: z.string().optional(), id: z.string().optional() }).optional(),
})

export type PermissionRequest = z.output<typeof permissionRequest>

// "Infinity", "-Infinity" and "NaN" come as strings.
const bound = z.union([z.number(), z.string()]).optional()
const when = z.looseObject({
  key: z.string(),
  op: z.enum(["eq", "neq"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
})
const option = z.looseObject({ value: z.string(), label: z.string().optional(), description: z.string().optional() })
const common = {
  key: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  hidden: z.boolean().optional(),
  when: z.array(when).optional(),
}

export const formField = z.discriminatedUnion("type", [
  z.looseObject({
    ...common,
    type: z.literal("string"),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    placeholder: z.string().optional(),
    default: z.string().optional(),
    options: z.array(option).optional(),
    custom: z.boolean().optional(),
  }),
  z.looseObject({ ...common, type: z.literal("number"), minimum: bound, maximum: bound, default: bound }),
  z.looseObject({ ...common, type: z.literal("integer"), minimum: bound, maximum: bound, default: bound }),
  z.looseObject({ ...common, type: z.literal("boolean"), default: z.boolean().optional() }),
  z.looseObject({
    ...common,
    type: z.literal("multiselect"),
    options: z.array(option),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    custom: z.boolean().optional(),
    default: z.array(z.string()).optional(),
  }),
  z.looseObject({ ...common, type: z.literal("external"), url: z.string() }),
])

export type FormField = z.output<typeof formField>

export const form = z.looseObject({
  id: z.string(),
  sessionID: z.string(),
  title: z.string(),
  metadata: z
    .looseObject({ tool: z.looseObject({ messageID: z.string().optional(), id: z.string().optional() }).optional() })
    .optional(),
  fields: z.array(formField),
})

export type Form = z.output<typeof form>
