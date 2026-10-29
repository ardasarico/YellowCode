// The requests app-server sends us, each method with its own params schema. Loose objects: fields Codex adds later
// pass through. A method not listed here gets a JSON-RPC error.
import { z } from "zod"
import { commandAction } from "./items.ts"

const nullish = <T extends z.ZodType>(schema: T) => schema.nullable().optional()

const ofItem = <S extends z.ZodRawShape>(shape: S) =>
  z.looseObject({ threadId: z.string(), turnId: z.string(), itemId: z.string(), ...shape })

export const execAmendment = z.looseObject({
  acceptWithExecpolicyAmendment: z.looseObject({ execpolicy_amendment: z.array(z.string()) }),
})
export const networkAmendment = z.looseObject({
  applyNetworkPolicyAmendment: z.looseObject({
    network_policy_amendment: z.looseObject({ host: z.string(), action: z.string() }),
  }),
})

// accept, acceptForSession, decline, cancel, or an object naming an amendment.
export const commandDecision = z.union([z.string(), execAmendment, networkAmendment])
export type CommandDecision = z.output<typeof commandDecision>

const network = z.looseObject({ enabled: z.boolean().nullable() })
const fileSystem = z.looseObject({
  read: nullish(z.array(z.string())),
  write: nullish(z.array(z.string())),
})
const permissionProfile = z.looseObject({ network: nullish(network), fileSystem: nullish(fileSystem) })
export type PermissionProfile = z.output<typeof permissionProfile>

const question = z.looseObject({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: nullish(z.array(z.looseObject({ label: z.string(), description: z.string() }))),
})

const elicitation = z.looseObject({
  threadId: z.string(),
  turnId: nullish(z.string()),
  serverName: z.string(),
  mode: z.string(),
  _meta: z.unknown().optional(),
  message: z.string().optional(),
  requestedSchema: z.unknown().optional(),
  url: z.string().optional(),
  elicitationId: z.string().optional(),
  title: z.string().optional(),
})
export type Elicitation = z.output<typeof elicitation>

const ask = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ method: z.literal(method), params })

const KNOWN = [
  ask(
    "item/commandExecution/requestApproval",
    ofItem({
      approvalId: nullish(z.string()),
      reason: nullish(z.string()),
      command: nullish(z.string()),
      cwd: nullish(z.string()),
      commandActions: nullish(z.array(commandAction)),
      networkApprovalContext: nullish(z.looseObject({ host: z.string(), protocol: z.string() })),
      proposedExecpolicyAmendment: nullish(z.array(z.string())),
      proposedNetworkPolicyAmendments: nullish(z.array(z.looseObject({ host: z.string(), action: z.string() }))),
      availableDecisions: nullish(z.array(commandDecision)),
    }),
  ),
  ask("item/fileChange/requestApproval", ofItem({ reason: nullish(z.string()), grantRoot: nullish(z.string()) })),
  ask(
    "item/permissions/requestApproval",
    ofItem({ cwd: z.string(), reason: z.string().nullable(), permissions: permissionProfile }),
  ),
  ask("item/tool/requestUserInput", ofItem({ questions: z.array(question) })),
  ask(
    "item/tool/call",
    z.looseObject({
      threadId: z.string(),
      turnId: z.string(),
      callId: z.string(),
      namespace: z.string().nullable(),
      tool: z.string(),
      arguments: z.unknown(),
    }),
  ),
  ask("mcpServer/elicitation/request", elicitation),
] as const

const request = z.discriminatedUnion("method", KNOWN)
const METHODS: ReadonlySet<string> = new Set(KNOWN.map((schema) => schema.shape.method.value))

export type ServerRequest = z.output<typeof request>

export type ReadRequest =
  | { kind: "request"; request: ServerRequest }
  | { kind: "unknown" }
  | { kind: "unreadable"; what: string }

export function readRequest(method: string, params: unknown): ReadRequest {
  if (!METHODS.has(method)) return { kind: "unknown" }
  const parsed = request.safeParse({ method, params })
  return parsed.success ? { kind: "request", request: parsed.data } : { kind: "unreadable", what: method }
}
