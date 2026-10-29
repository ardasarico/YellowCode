import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { AgentKindId, EffortId, ModeId, ModelRef } from "../agent/ids.ts"
import type { EffortRow, ModeKind, ModelRow, ModeRow } from "../agent/lists.ts"
import { DEFAULT_SETTINGS, saveSettings, startModeIn, type StoredSettings } from "./settings-file.ts"

// A Claude replay has no model list, so these stand in until the live process provides one.
export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]

// A model Shift+←→ steps to: `id` is shown and compared with what the agent reports, `ref` is the listed row that
// switches to it.
export type ModelChoice = { id: string; ref: ModelRef }

let choices: ModelChoice[] = []

// Something that did not happen (a model the agent refused, an agent that could not start, …); a new object each
// time, so the same text shows again.
export const [controlProblem, setControlProblem] = createSignal<{ text: string } | null>(null)

export function setModelChoices(next: ModelChoice[]): void {
  choices = next
}

// What the agent is told to switch to for a model: the listed row of its choice, which the agent may switch to faster
// than the full id.
export function modelRef(id: string): ModelRef {
  return choices.find((choice) => choice.id === id)?.ref ?? { provider: null, id }
}

// The id the knobs keep for a model of an agent with several providers, which can list one id under two of them.
export const providerModelId = (provider: string, id: string): string => `${provider}/${id}`

// The family rows (opus, sonnet, …) in the agent's order, each under the id it stands for; every row when there are
// none. Rows of an agent with several providers are each a choice of their own.
export function modelChoices(models: ModelRow[]): ModelChoice[] {
  if (models.some(({ ref }) => ref.provider !== null))
    return models.flatMap(({ ref }) =>
      ref.provider === null ? [] : [{ id: providerModelId(ref.provider, ref.id), ref }],
    )
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
  const row = models.find(
    ({ ref, resolves }) =>
      model !== null &&
      (ref.provider === null
        ? ref.id === model || resolves === model
        : providerModelId(ref.provider, ref.id) === model),
  )
  return (row ?? models[0])?.efforts ?? []
}

// Settings for the open session only; they are never saved.
export type SessionSettings = { peerMessages: "run" | "ask"; peerVisible: "yes" | "no" }

export const DEFAULT_SESSION_SETTINGS: SessionSettings = { peerMessages: "run", peerVisible: "yes" }

export type Settings = StoredSettings &
  SessionSettings & {
    model: string | null
    effort: EffortId | null
    ultracode: boolean
  }

const [settings, setSettings] = createStore<Settings>({
  ...DEFAULT_SETTINGS,
  ...DEFAULT_SESSION_SETTINGS,
  model: null,
  effort: "high",
  ultracode: false,
})

export { settings }

export function initSettings(stored: StoredSettings): void {
  setSettings(stored)
}

// What the agent says the session uses, or nothing shown while that is unknown.
export function setKnobs(knobs: Partial<Pick<Settings, "model" | "effort" | "ultracode">>): void {
  setSettings(knobs)
}

export function setSessionSettings(patch: Partial<SessionSettings>): void {
  setSettings(patch)
}

export function setSetting<K extends keyof StoredSettings>(key: K, value: StoredSettings[K]): void {
  setSettings({ [key]: value })
  saveSettings(settings)
}

export function resetSetting(key: keyof StoredSettings): void {
  setSetting(key, DEFAULT_SETTINGS[key])
}

export const defaultModeOf = (agent: AgentKindId): ModeId | null => startModeIn(settings, agent)

// The saved mode the agent already has changes nothing, so the running session is not switched again; null drops it.
// A path setter would merge into the object the store started with, DEFAULT_SETTINGS' own, so the entries are
// replaced at the top.
export function setDefaultMode(agent: AgentKindId, mode: ModeId | null): void {
  if (defaultModeOf(agent) !== mode)
    setSettings({
      agents: { ...settings.agents, [agent]: { ...settings.agents[agent], defaultMode: mode ?? undefined } },
    })
  saveSettings(settings)
}

// Back to what nothing saved gives.
export const resetDefaultMode = (agent: AgentKindId): void =>
  setDefaultMode(agent, startModeIn(DEFAULT_SETTINGS, agent))

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

// Nothing to step from while the agent has not said what it uses (or the model has no effort levels).
export function stepEffort(levels: EffortId[], step: 1 | -1): EffortId | null {
  if (settings.effort === null) return null
  const index = levels.indexOf(settings.effort)
  const next = levels[Math.min(levels.length - 1, Math.max(0, index + step))]
  return next === undefined ? null : pickEffort(next)
}

// A model as favorites keep it: the listed row it is picked by, which stays when the model behind an alias changes.
export function favoriteKey(id: string): string {
  const ref = modelRef(id)
  return ref.provider === null ? ref.id : providerModelId(ref.provider, ref.id)
}

export const favoritesOf = (agent: AgentKindId): string[] => settings.agents[agent]?.favoriteModels ?? []

export function toggleFavorite(agent: AgentKindId, id: string): void {
  const key = favoriteKey(id)
  const saved = favoritesOf(agent)
  const next = saved.includes(key) ? saved.filter((one) => one !== key) : [...saved, key]
  setSettings({
    agents: {
      ...settings.agents,
      [agent]: { ...settings.agents[agent], favoriteModels: next.length > 0 ? next : undefined },
    },
  })
  saveSettings(settings)
}

// Steps through the favorites that are listed, or every model when none is.
export function stepModel(step: 1 | -1, current: string | null, favorites: string[] = []): string | null {
  const model = settings.model ?? current
  if (model === null) return null
  const all = choices.length > 0 ? choices.map(({ id }) => id) : MODELS
  const marked = all.filter((id) => favorites.includes(favoriteKey(id)))
  const ids = marked.length > 0 ? marked : all
  // A dated or suffixed id such as claude-opus-5-5-20261001[1m] steps from its plain model, unless it is a choice.
  const plain = model.replace(/(?:-\d{8})?(?:\[.+\])?$/, "")
  const index = ids.includes(model) ? ids.indexOf(model) : ids.indexOf(plain)
  const next = index === -1 ? 0 : (index + step + ids.length) % ids.length
  const id = ids[next]
  return id === undefined ? null : pickModel(id)
}

// What the user sees for a mode: its label in the agent's list, or the id the agent reported.
export const modeLabel = (modes: ModeRow[], id: string): string => modes.find((mode) => mode.id === id)?.label ?? id

// A mode as mods see it; an id the agent did not list is its own label, of kind "other".
export function modeOf(modes: ModeRow[], id: string | null): { id: string; label: string; kind: ModeKind } | null {
  if (id === null) return null
  const row = modes.find((mode) => mode.id === id)
  return { id, label: row?.label ?? id, kind: row?.kind ?? "other" }
}

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
