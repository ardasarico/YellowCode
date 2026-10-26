import { createSignal } from "solid-js"
import { log } from "../log/log.ts"
import type { ModSettings, ModStorage, ModSettingDefinition, ModSettingDefinitions, ModSettingValue } from "./api.ts"
import { parseKey } from "./keys.ts"
import { guarded } from "./registry.ts"
import { readAppValue, writeAppValue } from "./storage.ts"

export type SettingsHandle = ModSettings<ModSettingDefinitions> & { readonly definitions: ModSettingDefinitions }

function valid(definition: ModSettingDefinition, value: unknown): value is ModSettingValue {
  switch (definition.type) {
    case "choice":
      return typeof value === "string" && definition.options.some((option) => option.id === value)
    case "boolean":
      return typeof value === "boolean"
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= definition.min && value <= definition.max
    case "text":
      return typeof value === "string"
    case "key":
      return typeof value === "string" && parseKey(value) !== null
    default:
      return false
  }
}

// The values live in the mod's data file, next to what it keeps with mod.storage.
export function createSettings(id: string, definitions: ModSettingDefinitions, storage: ModStorage): SettingsHandle {
  const stored = readAppValue(storage, "settings")
  const saved: Record<string, unknown> = typeof stored === "object" && stored !== null ? { ...stored } : {}
  const initial: Record<string, ModSettingValue> = {}
  for (const [key, definition] of Object.entries(definitions)) {
    // Before options had ids, the label was stored.
    const value =
      definition.type === "choice"
        ? (definition.options.find((option) => option.label === saved[key] && option.id !== saved[key])?.id ??
          saved[key])
        : saved[key]
    if (value !== undefined && !valid(definition, value))
      log.warn(`mod ${id}: setting ${key} is invalid, using the default`)
    initial[key] = value !== undefined && valid(definition, value) ? value : definition.default
  }
  const [values, setValues] = createSignal(initial)
  const listeners = new Map<string, Set<(value: ModSettingValue) => void>>()

  return {
    definitions,
    get(key) {
      const value = values()[key]
      if (value === undefined) throw new Error(`mod ${id} has no setting ${key}`)
      return value
    },
    set(key, value) {
      const definition = definitions[key]
      if (!definition || !valid(definition, value)) return log.warn(`mod ${id}: ignored an invalid ${key}`)
      setValues((current) => ({ ...current, [key]: value }))
      writeAppValue(storage, "settings", values())
      for (const listener of listeners.get(key) ?? []) guarded(id, () => listener(value))
    },
    onChange(key, listener) {
      const set = listeners.get(key) ?? new Set()
      listeners.set(key, set)
      set.add(listener)
      return () => set.delete(listener)
    },
  }
}
