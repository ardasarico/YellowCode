// What /model lists: Favorites, then one group per added provider, each cut at CUT rows until expanded or searched.
import type { AgentKindId, ModelRef } from "../agent/ids.ts"

export const CUT = 20

// `id` is what the provider's knobs compare with the model it reports.
export type PickerModel = { provider: AgentKindId; id: string; ref: ModelRef; label: string; note?: string }

// `models` null: the provider's list is still being looked up.
export type PickerGroup = { provider: AgentKindId; name: string; models: PickerModel[] | null }

export type PickerLine =
  | { kind: "model"; model: PickerModel; favorite: boolean; hidden: boolean }
  | { kind: "more"; provider: AgentKindId; count: number; next: PickerModel }
  | { kind: "loading"; provider: AgentKindId }

export type PickerSection = { title: string; favorites: boolean; lines: PickerLine[] }

export type PickerView = {
  query: string
  showHidden: boolean
  expanded: ReadonlySet<AgentKindId>
  favorite: (model: PickerModel) => boolean
  hidden: (model: PickerModel) => boolean
}

// A dated or suffixed id such as claude-opus-5-5-20261001[1m] is its plain model's.
const plain = (id: string) => id.replace(/(?:-\d{8})?(?:\[.+\])?$/, "")

// True when `model` is the one `now` names, dated or suffixed or not.
export const isModelOf = (model: PickerModel, now: { provider: AgentKindId; id: string }): boolean =>
  model.provider === now.provider && (model.id === now.id || model.id === plain(now.id))

export function matches(model: PickerModel, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const ref = model.ref.provider === null ? model.ref.id : `${model.ref.provider}/${model.ref.id}`
  return [model.label, model.id, ref].some((text) => text.toLowerCase().includes(needle))
}

export function pickerSections(groups: PickerGroup[], view: PickerView): PickerSection[] {
  const line = (model: PickerModel): PickerLine => ({
    kind: "model",
    model,
    favorite: view.favorite(model),
    hidden: view.hidden(model),
  })
  const shown = (models: PickerModel[]) =>
    models.filter((model) => (view.showHidden || !view.hidden(model)) && matches(model, view.query))
  const favorites = shown(groups.flatMap((group) => group.models ?? [])).filter(view.favorite)
  const sections: PickerSection[] = []
  if (favorites.length > 0) sections.push({ title: "Favorites", favorites: true, lines: favorites.map(line) })
  for (const group of groups) {
    if (group.models === null) {
      sections.push({ title: group.name, favorites: false, lines: [{ kind: "loading", provider: group.provider }] })
      continue
    }
    const models = shown(group.models)
    const next = models[CUT]
    const cut = !view.query.trim() && !view.expanded.has(group.provider) && next !== undefined
    const lines = (cut ? models.slice(0, CUT) : models).map(line)
    if (cut) lines.push({ kind: "more", provider: group.provider, count: models.length - CUT, next })
    if (lines.length > 0) sections.push({ title: group.name, favorites: false, lines })
  }
  return sections
}

// What Shift+←→ walks: the favorites in the picker's order, hidden ones left out.
export const favoriteWalk = (groups: PickerGroup[], view: Pick<PickerView, "favorite" | "hidden">): PickerModel[] =>
  groups.flatMap((group) => group.models ?? []).filter((model) => view.favorite(model) && !view.hidden(model))

// The models a typed /model name stands for: those it names exactly, else those whose names contain it.
export function modelsNamed(groups: PickerGroup[], name: string): PickerModel[] {
  const needle = name.trim().toLowerCase()
  const all = groups.flatMap((group) => group.models ?? [])
  const exact = all.filter((model) =>
    [model.id, model.ref.id, model.label, `${model.ref.provider}/${model.ref.id}`].some(
      (text) => text.toLowerCase() === needle,
    ),
  )
  return exact.length > 0 ? exact : all.filter((model) => matches(model, needle))
}
