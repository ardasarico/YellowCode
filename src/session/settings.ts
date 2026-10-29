import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { AgentKindId, EffortId, ModeId, ModelRef } from "../agent/ids.ts"
import type { EffortRow, ModelRow, ModeRow } from "../agent/lists.ts"
import { DEFAULT_SETTINGS, defaultModeIn, saveSettings, type StoredSettings } from "./settings-file.ts"

// Replay has no model list from claude, so these stand in until the live process provides one.
export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]

// A model Shift+←→ steps to: `id` is shown and compared with what claude reports, `ref` is the listed row that switches
// to it.
export type ModelChoice = { id: string; ref: ModelRef }

let choices: ModelChoice[] = []

// Something claude refused (a model, an effort, …); a new object each time, so the same text shows again.
export const [controlProblem, setControlProblem] = createSignal<{ text: string } | null>(null)

export function setModelChoices(next: ModelChoice[]): void {
  choices = next
}

// What the agent is told to switch to for a model: the listed row of its choice, which the agent may switch to faster
// than the full id.
export function modelRef(id: string): ModelRef {
  return choices.find((choice) => choice.id === id)?.ref ?? { provider: null, id }
}

// The family rows (opus, sonnet, …) in claude's order, each under the id it stands for; every row when there are none.
export function modelChoices(models: ModelRow[]): ModelChoice[] {
  const aliases = models.filter(({ ref }) => !ref.id.startsWith("claude-") && ref.id !== "default")
  const rows = aliases.length > 0 ? aliases : models
  const seen = new Set<string>()
  return rows.flatMap(({ ref, resolves }) => {
    const id = resolves ?? ref.id
    if (seen.has(id)) return []
    seen.add(id)
    return [{ id, ref }]
  })
}

// The effort levels of the model the session uses; a model the agent did not list has the first row's.
export function effortsOf(models: ModelRow[], model: string | null): EffortRow[] {
  const row = models.find(({ ref, resolves }) => model !== null && (ref.id === model || resolves === model))
  return (row ?? models[0])?.efforts ?? []
}

export type Settings = StoredSettings & {
  model: string | null
  effort: EffortId | null
  ultracode: boolean
}

const [settings, setSettings] = createStore<Settings>({
  ...DEFAULT_SETTINGS,
  model: null,
  effort: "high",
  ultracode: false,
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
  saveSettings(settings)
}

export function resetSetting(key: keyof StoredSettings): void {
  setSetting(key, DEFAULT_SETTINGS[key])
}

export const defaultModeOf = (agent: AgentKindId): ModeId => defaultModeIn(settings, agent)

// The saved mode the agent already has changes nothing, so the running session is not switched again. A path setter
// would merge into the object the store started with, DEFAULT_SETTINGS' own, so the entries are replaced at the top.
export function setDefaultMode(agent: AgentKindId, mode: ModeId): void {
  if (defaultModeOf(agent) !== mode)
    setSettings({ agents: { ...settings.agents, [agent]: { ...settings.agents[agent], defaultMode: mode } } })
  saveSettings(settings)
}

// A pick says what changed, so only a change goes to the agent; null when nothing did.
export function pickModel(id: string): string | null {
  if (settings.model === id) return null
  setSettings("model", id)
  return id
}

export function pickEffort(level: EffortId): EffortId | null {
  if (settings.effort === level) return null
  setSettings("effort", level)
  return level
}

// The models /model and Shift+←→ offer, as ids.
export const modelIds = () => (choices.length > 0 ? choices.map(({ id }) => id) : MODELS)

// The id a typed /model name stands for: an alias such as "opus", or an id; null when YellowCode does not list it.
export function modelFor(name: string): string | null {
  const needle = name.toLowerCase()
  return (
    choices.find((choice) => choice.ref.id.toLowerCase() === needle || choice.id.toLowerCase() === needle)?.id ??
    MODELS.find((id) => id === needle) ??
    null
  )
}

// Nothing to step from while claude has not said what it uses (or the model has no effort levels).
export function stepEffort(levels: EffortId[], step: 1 | -1): EffortId | null {
  if (settings.effort === null) return null
  const index = levels.indexOf(settings.effort)
  const next = levels[Math.min(levels.length - 1, Math.max(0, index + step))]
  return next === undefined ? null : pickEffort(next)
}

export function stepModel(step: 1 | -1, current: string | null): string | null {
  const model = settings.model ?? current
  if (model === null) return null
  const ids = choices.length > 0 ? choices.map(({ id }) => id) : MODELS
  // A dated or suffixed id such as claude-opus-5-5-20261001[1m] steps from its plain model, unless it is a choice.
  const plain = model.replace(/(?:-\d{8})?(?:\[.+\])?$/, "")
  const index = ids.includes(model) ? ids.indexOf(model) : ids.indexOf(plain)
  const next = index === -1 ? 0 : (index + step + ids.length) % ids.length
  const id = ids[next]
  return id === undefined ? null : pickModel(id)
}

// What the user sees for a mode: its label in the agent's list, or the id the agent reported.
export const modeLabel = (modes: ModeRow[], id: string): string => modes.find((mode) => mode.id === id)?.label ?? id

// Shift+Tab walks the modes that cycle, in list order; any other mode goes to the first, and none yet counts as the
// first.
export function nextMode(modes: ModeRow[], current: ModeId | null): ModeId | null {
  const cycle = modes.filter((mode) => mode.cycle)
  const at = current === null ? 0 : cycle.findIndex((mode) => mode.id === current)
  return (at === -1 ? cycle[0] : cycle[(at + 1) % cycle.length])?.id ?? null
}

export function toggleUltracode(): boolean {
  setSettings("ultracode", (on) => !on)
  return settings.ultracode
}
