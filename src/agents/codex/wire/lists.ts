// The lists Codex keeps outside a thread: skills, MCP servers and file matches. Loose objects: fields
// Codex adds later pass.
import { z } from "zod"

const nullish = <T extends z.ZodType>(schema: T) => schema.nullable().optional()

export const skillsList = z.looseObject({
  data: z.array(
    z.looseObject({
      skills: z.array(
        z.looseObject({
          name: z.string(),
          description: z.string(),
          shortDescription: nullish(z.string()),
          interface: nullish(
            z.looseObject({ displayName: nullish(z.string()), shortDescription: nullish(z.string()) }),
          ),
          path: z.string(),
          scope: z.string(),
          enabled: z.boolean(),
          pluginId: nullish(z.string()),
        }),
      ),
    }),
  ),
})

export const skillsWriteResult = z.looseObject({ effectiveEnabled: z.boolean() })

export const mcpStatusPage = z.looseObject({
  data: z.array(
    z.looseObject({
      name: z.string(),
      runtimeStatus: nullish(z.string()),
      pluginId: nullish(z.string()),
      // The endpoint's origin, without credentials, path or query.
      httpOrigin: nullish(z.string()),
      serverInfo: nullish(z.looseObject({ name: z.string(), version: z.string() })),
      tools: z.record(z.string(), z.unknown()),
      toolsError: nullish(z.string()),
      authStatus: z.string(),
    }),
  ),
  nextCursor: nullish(z.string()),
})

export const oauthLogin = z.looseObject({ authorizationUrl: z.string() })

// The notifications that change a list. A server's startup state comes per server; skills changed on disk say no more.
export const mcpStartup = z.looseObject({ threadId: nullish(z.string()), name: z.string(), status: z.string() })
export const oauthDone = z.looseObject({ name: z.string(), success: z.boolean(), error: nullish(z.string()) })

export const fileMatches = z.looseObject({
  files: z.array(z.looseObject({ path: z.string(), match_type: z.string() })),
})

export type CodexMcpServer = z.output<typeof mcpStatusPage>["data"][number]
