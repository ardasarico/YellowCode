import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { EFFORT_LEVELS, type EffortLevel } from "../theme/brand.ts"
import { DEFAULT_SETTINGS, type PermissionMode, saveSettings, type StoredSettings } from "./settings-file.ts"

import type { ModelInfo } from "../protocol/messages.ts"

// Replay has no model list from claude, so these stand in until the live process provides one.
export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]

// A model Shift+←→ steps to: `id` is shown and compared with what claude reports, `value` is what is sent to switch.
export type ModelChoice = { id: string; value: string }

let choices: ModelChoice[] = []

// Something claude refused (a model, an effort, …); a new object each time, so the same text shows again.
export const [controlProblem, setControlProblem] = createSignal<{ text: string } | null>(null)

export function setModelChoices(next: ModelChoice[]): void {
  choices = next
}

// What claude is sent to switch to a model: the choice's alias, which it answers at once (a full id takes ~0.7 s).
export function modelValue(id: string): string {
  return choices.find((choice) => choice.id === id)?.value ?? id
}

// The family rows (opus, sonnet, …) in claude's order, each under the id it stands for; every row when there are none.
export function modelChoices(models: ModelInfo[]): ModelChoice[] {
  const aliases = models.filter(({ value }) => !value.startsWith("claude-") && value !== "default")
  const rows = aliases.length > 0 ? aliases : models
  const seen = new Set<string>()
  return rows.flatMap(({ value, resolvedModel }) => {
    const id = resolvedModel ?? value
    if (seen.has(id)) return []
    seen.add(id)
    return [{ id, value }]
  })
}

// `sessionMode` is a permission mode Shift+Tab set for the running session only; the saved one is `permissionMode`.
export type Settings = StoredSettings & {
  model: string | null
  effort: EffortLevel | null
  ultracode: boolean
  sessionMode: PermissionMode | null
}

const [settings, setSettings] = createStore<Settings>({
  ...DEFAULT_SETTINGS,
  model: null,
  effort: "high",
  ultracode: false,
  sessionMode: null,
})

export { settings }

export function initSettings(stored: StoredSettings): void {
  setSettings(stored)
}

// What claude says the session uses, or nothing shown while that is unknown.
export function setKnobs(knobs: Partial<Pick<Settings, "model" | "effort" | "ultracode">>): void {
  setSettings(knobs)
}

export function setSetting<K extends keyof StoredSettings>(key: K, value: StoredSettings[K]): void {
  setSettings({ [key]: value })
  const { theme, sidebar, thinking, sessionTitle, permissionMode, editor, notifications } = settings
  saveSettings({ theme, sidebar, thinking, sessionTitle, permissionMode, editor, notifications })
}

export function resetSetting(key: keyof StoredSettings): void {
  setSetting(key, DEFAULT_SETTINGS[key])
}

// Nothing to step from while claude has not said what it uses (or the model has no effort levels).
export function stepEffort(step: 1 | -1): void {
  if (settings.effort === null) return
  const index = EFFORT_LEVELS.indexOf(settings.effort)
  const next = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, index + step))
  setSettings("effort", EFFORT_LEVELS[next] ?? "high")
}

export function stepModel(step: 1 | -1, current: string | null): void {
  const model = settings.model ?? current
  if (model === null) return
  const ids = choices.length > 0 ? choices.map(({ id }) => id) : MODELS
  // A dated or suffixed id such as claude-opus-5-5-20261001[1m] steps from its plain model, unless it is a choice.
  const plain = model.replace(/(?:-\d{8})?(?:\[.+\])?$/, "")
  const index = ids.includes(model) ? ids.indexOf(model) : ids.indexOf(plain)
  const next = index === -1 ? 0 : (index + step + ids.length) % ids.length
  setSettings("model", ids[next] ?? null)
}

const MODE_CYCLE: Partial<Record<string, PermissionMode>> = { auto: "acceptEdits", acceptEdits: "plan", plan: "auto" }

// Shift+Tab: auto, accept edits, plan, and back to auto; any other mode goes to auto.
export function nextMode(current: string | null): PermissionMode {
  return MODE_CYCLE[current ?? "auto"] ?? "auto"
}

// Cleared first, so asking for the mode set last still goes out when claude moved away from it meanwhile.
export function setSessionMode(mode: PermissionMode): void {
  setSettings("sessionMode", null)
  setSettings("sessionMode", mode)
}

export function toggleUltracode(): void {
  setSettings("ultracode", (on) => !on)
}
