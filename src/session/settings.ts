import { createStore } from "solid-js/store"
import { EFFORT_LEVELS, type EffortLevel } from "../theme/brand.ts"

// Replay has no model list from claude, so these stand in until the live process provides one.
export const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]

export type Settings = { model: string | null; effort: EffortLevel | null; ultracode: boolean }

const [settings, setSettings] = createStore<Settings>({ model: null, effort: "high", ultracode: false })

export { settings }

export function stepEffort(step: 1 | -1): void {
  const index = settings.effort === null ? 0 : EFFORT_LEVELS.indexOf(settings.effort)
  const next = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, index + step))
  setSettings("effort", EFFORT_LEVELS[next] ?? "high")
}

export function stepModel(step: 1 | -1, current: string | null): void {
  const index = MODELS.indexOf(settings.model ?? current ?? "")
  const next = index === -1 ? 0 : (index + step + MODELS.length) % MODELS.length
  setSettings("model", MODELS[next] ?? null)
}

export function toggleUltracode(): void {
  setSettings("ultracode", (on) => !on)
}
