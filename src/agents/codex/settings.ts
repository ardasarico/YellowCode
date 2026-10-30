// Codex's own settings in /settings: config/read through the allowlist, written with config/value/write to the user's
// config.toml. A thread keeps the config it started with, so every change applies in a new session.
import { join } from "node:path"
import type { Outcome } from "../../agent/ids.ts"
import type { SettingControl, SettingRow, SettingValue } from "../../agent/settings.ts"
import { log } from "../../log/log.ts"
import { allowedConfig, type AllowedConfig, type LayerName, type SettingKey } from "./allow.ts"
import { RpcError, type Rpc } from "./transport.ts"
import { resultOf } from "./wire/thread.ts"
import { configWriteResult } from "./wire/settings.ts"

type Setting = {
  id: string
  key: SettingKey
  label: string
  note: string | null
  control: SettingControl
}

// "" stands for no value of config.toml's own, which leaves the pick to Codex.
const OWN = ""
const own = { value: OWN, label: "default" }
const choice = (...values: [string, string][]): SettingControl => ({
  type: "choice",
  options: [own, ...values.map(([value, label]) => ({ value, label }))],
})
const tokens: SettingControl = { type: "number", min: 1, max: null, step: 1, unit: "tokens" }

// Keys another picker or the modes already cover are left out, and so are borderline ones such as
// model_context_window, service_tier and personality.
const SETTINGS: Setting[] = [
  {
    id: "web-search",
    key: "web_search",
    label: "Web search",
    note: null,
    control: choice(["disabled", "off"], ["cached", "cached"], ["indexed", "indexed"], ["live", "live"]),
  },
  {
    id: "compaction.threshold",
    key: "model_auto_compact_token_limit",
    label: "Auto-compact at",
    note: "Tokens in the context that start a compaction",
    control: tokens,
  },
  {
    id: "verbosity",
    key: "model_verbosity",
    label: "Verbosity",
    note: "How long the model's answers are",
    control: choice(["low", "low"], ["medium", "medium"], ["high", "high"]),
  },
  {
    id: "tool-output.tokens",
    key: "tool_output_token_limit",
    label: "Tool output limit",
    note: "Tokens of a tool's output the model sees",
    control: tokens,
  },
  {
    id: "login-shell",
    key: "allow_login_shell",
    label: "Login shells",
    note: "The model may run commands in a login shell",
    control: {
      type: "choice",
      options: [
        { value: "true", label: "on" },
        { value: "false", label: "off" },
      ],
    },
  },
]

const MANAGED = new Set([
  "mdm",
  "enterpriseManaged",
  "legacyManagedConfigTomlFromFile",
  "legacyManagedConfigTomlFromMdm",
])

const layerOf = (name: LayerName) =>
  MANAGED.has(name.type)
    ? "managed"
    : name.type === "user" && name.profile
      ? "profile"
      : name.type === "sessionFlags"
        ? "session"
        : name.type === "packagedDefaults"
          ? "default"
          : name.type

const fileOf = (name: LayerName) =>
  name.file ?? (name.dotCodexFolder ? join(name.dotCodexFolder, "config.toml") : name.type)

// The layers Codex reads after the user's config.toml, which win over a write to it.
const WINNING = new Set(["project", "profile", "session", "managed"])

function rowOf(setting: Setting, read: AllowedConfig): SettingRow {
  const value = read.config[setting.key]
  const origin = read.origins[setting.key]
  const layer = origin ? layerOf(origin.name) : null
  const ownOption = setting.control.type === "choice" && setting.control.options.some((option) => option.value === OWN)
  return {
    id: setting.id,
    label: setting.label,
    section: "",
    note: setting.note,
    control: setting.control,
    value: value === undefined ? (ownOption ? OWN : null) : typeof value === "boolean" ? String(value) : value,
    writable: true,
    applies: "new-session",
    origin: origin && layer ? { file: fileOf(origin.name), layer } : null,
    overriddenBy: layer && WINNING.has(layer) ? layer : null,
  }
}

// What config.toml gets for a row's value: null removes the key; undefined is a value the row does not take.
function wireOf(setting: Setting, value: SettingValue): SettingKeyWire | undefined {
  const { control } = setting
  if (control.type === "number")
    return value === null || (typeof value === "number" && Number.isInteger(value) && value >= (control.min ?? 0))
      ? value
      : undefined
  if (control.type !== "choice" || typeof value !== "string") return undefined
  if (!control.options.some((option) => option.value === value)) return undefined
  if (value === OWN) return null
  return value === "true" || value === "false" ? value === "true" : value
}

type SettingKeyWire = string | number | boolean | null

const conflict = (error: unknown) =>
  error instanceof RpcError &&
  typeof error.data === "object" &&
  error.data !== null &&
  "config_write_error_code" in error.data &&
  error.data.config_write_error_code === "configVersionConflict"

const problemOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createSettings(rpc: () => Pick<Rpc, "request">, cwd: string) {
  // The version of the user's config.toml as last read or written, which a write expects.
  let version: string | null = null

  async function read(): Promise<AllowedConfig> {
    const allowed = allowedConfig(await rpc().request("config/read", { includeLayers: true, cwd }))
    version = allowed.layers?.find((layer) => layer.name.type === "user" && !layer.name.profile)?.version ?? null
    return allowed
  }

  async function send(setting: Setting, value: SettingKeyWire): Promise<Outcome> {
    const reply = resultOf(
      await rpc().request("config/value/write", {
        keyPath: setting.key,
        value,
        mergeStrategy: "replace",
        ...(version === null ? {} : { expectedVersion: version }),
      }),
      configWriteResult,
      "config/value/write",
    )
    // Written, but the new version is unknown: the next write reads it first.
    version = reply.kind === "ok" ? reply.value.version : null
    if (reply.kind !== "ok") return { ok: true, note: "Written; Codex's answer was not read" }
    const over = reply.value.overriddenMetadata?.overridingLayer.name.type
    if (reply.value.status === "okOverridden" && over)
      return { ok: true, note: `The ${layerOf({ type: over })} config sets ${setting.label} too, and wins` }
    return { ok: true, note: "Codex takes it in a new session" }
  }

  return {
    rows: async () => {
      const allowed = await read()
      return SETTINGS.map((setting) => rowOf(setting, allowed))
    },
    // A config.toml that changed since it was read is read again, and the write goes once more.
    async write(id: string, value: SettingValue): Promise<Outcome> {
      const setting = SETTINGS.find((row) => row.id === id)
      if (!setting) return { ok: false, problem: `Codex has no setting ${id}` }
      const wire = wireOf(setting, value)
      if (wire === undefined) return { ok: false, problem: `${setting.label} cannot be ${String(value)}` }
      try {
        if (version === null) await read()
        return await send(setting, wire)
      } catch (error) {
        if (!conflict(error)) return { ok: false, problem: problemOf(error) }
        log.info("codex: config.toml changed since it was read; reading it again")
      }
      try {
        await read()
        return await send(setting, wire)
      } catch (error) {
        return { ok: false, problem: problemOf(error) }
      }
    },
  }
}
