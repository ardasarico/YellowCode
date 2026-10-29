// What YellowCode keeps of config/read. Providers hold their URLs, headers and key names, MCP servers their
// environments and headers, otel its exporters' headers, so only each provider's name and the keys /settings shows
// pass; the rest of the reply is dropped here, before other code or a recording sees it.
import { z } from "zod"
import type { Rpc } from "./transport.ts"

const field = <T extends z.ZodType>(schema: T) => schema.nullable().optional().catch(undefined)
const whole = z.number().int()

// The config.toml keys /settings shows, by their key path. A value of another shape is dropped alone.
export const SETTING_KEYS = {
  web_search: z.string(),
  model_auto_compact_token_limit: whole,
  model_verbosity: z.string(),
  tool_output_token_limit: whole,
  allow_login_shell: z.boolean(),
} as const

export type SettingKey = keyof typeof SETTING_KEYS
export type SettingKeyValue = string | number | boolean

const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTING_KEYS, key)

const providers = z.record(z.string(), z.looseObject({ name: z.string().nullable().optional() }))

// Where a value comes from: a file, a project's .codex folder, or a managed or session source named by type only.
const layerName = z.object({
  type: z.string(),
  file: z.string().optional(),
  dotCodexFolder: z.string().optional(),
  profile: z.string().nullable().optional(),
})
const layerMeta = z.object({ name: layerName, version: z.string() })

const configReply = z.looseObject({
  config: z.looseObject({ model_providers: field(providers) }),
  origins: z.record(z.string(), layerMeta.optional().catch(undefined)).optional().catch(undefined),
  layers: z
    .array(z.object({ name: layerName, version: z.string(), disabledReason: z.string().nullable().optional() }))
    .nullable()
    .optional()
    .catch(undefined),
})

export type LayerName = z.output<typeof layerName>
export type LayerMeta = z.output<typeof layerMeta>

export type AllowedConfig = {
  config: { model_providers: Record<string, { name?: string }> } & Partial<Record<SettingKey, SettingKeyValue>>
  origins: Partial<Record<SettingKey, LayerMeta>>
  layers: { name: LayerName; version: string; disabledReason: string | null }[] | null
}

// The reply as YellowCode keeps it; a reply that does not fit keeps nothing. Unset keys (null) are left out.
export function allowedConfig(reply: unknown): AllowedConfig {
  const parsed = configReply.safeParse(reply)
  if (!parsed.success) return { config: { model_providers: {} }, origins: {}, layers: null }
  const { config, origins, layers } = parsed.data
  const names = Object.entries(config.model_providers ?? {}).map(
    ([id, entry]) => [id, entry.name ? { name: entry.name } : {}] as const,
  )
  const settings: Partial<Record<SettingKey, SettingKeyValue>> = {}
  for (const key of Object.keys(SETTING_KEYS).filter(isSettingKey)) {
    const value = SETTING_KEYS[key].safeParse(config[key])
    if (value.success) settings[key] = value.data
  }
  const kept: Partial<Record<SettingKey, LayerMeta>> = {}
  for (const [key, meta] of Object.entries(origins ?? {})) if (meta && isSettingKey(key)) kept[key] = meta
  return {
    config: { model_providers: Object.fromEntries(names), ...settings },
    origins: kept,
    layers:
      layers?.map(({ name, version, disabledReason }) => ({ name, version, disabledReason: disabledReason ?? null })) ??
      null,
  }
}

// Every provider config.toml names, by id, with its name; empty when Codex does not say.
export async function providerNames(rpc: Rpc, cwd: string): Promise<Map<string, string>> {
  const reply = await rpc.request("config/read", { cwd }).catch(() => null)
  const listed = allowedConfig(reply).config.model_providers
  return new Map(Object.entries(listed).map(([id, entry]) => [id, entry.name ?? id]))
}
