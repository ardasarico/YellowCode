import { createSignal } from "solid-js"
import { log } from "../log/log.ts"
import type { ModSettings, ModStorage, SettingDefinition, SettingDefinitions, SettingValue } from "./api.ts"

export type SettingsHandle = ModSettings<SettingDefinitions> & { readonly definitions: SettingDefinitions }

function valid(definition: SettingDefinition, value: unknown): value is SettingValue {
  switch (definition.type) {
    case "choice":
      return typeof value === "string" && definition.options.includes(value)
    case "boolean":
      return typeof value === "boolean"
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= definition.min && value <= definition.max
    case "text":
      return typeof value === "string"
    default:
      return false
  }
}

// The values live under "settings" in the mod's data file, next to what it keeps with mod.storage.
export function createSettings(id: string, definitions: SettingDefinitions, storage: ModStorage): SettingsHandle {
  const stored = storage.get("settings")
  const saved: Record<string, unknown> = typeof stored === "object" && stored !== null ? { ...stored } : {}
  const initial: Record<string, SettingValue> = {}
  for (const [key, definition] of Object.entries(definitions)) {
    const value = saved[key]
    if (value !== undefined && !valid(definition, value))
      log.warn(`mod ${id}: setting ${key} is invalid, using the default`)
    initial[key] = value !== undefined && valid(definition, value) ? value : definition.default
  }
  const [values, setValues] = createSignal(initial)
  const listeners = new Map<string, Set<(value: SettingValue) => void>>()

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
      storage.set("settings", values())
      for (const listener of listeners.get(key) ?? []) listener(value)
    },
    onChange(key, listener) {
      const set = listeners.get(key) ?? new Set()
      listeners.set(key, set)
      set.add(listener)
      return () => set.delete(listener)
    },
  }
}
