import type { KeyEvent } from "@opentui/core"
import { createSignal, untrack } from "solid-js"
import type { AgentKindId, ModelRef } from "../agent/ids.ts"
import type { ModelRow } from "../agent/lists.ts"
import {
  isModelOf,
  type PickerGroup,
  type PickerLine,
  type PickerModel,
  type PickerSection,
  pickerSections,
} from "../models/picker.ts"
import { modelKey } from "../session/settings-file.ts"
import { isFavorite, isHidden, toggleFavorite, toggleHidden } from "../session/settings.ts"
import { theme } from "../theme/theme.ts"
import { Dialog } from "./dialog/dialog.tsx"
import type { DialogItem, DialogSection } from "./dialog/list.ts"
import { printable } from "./dialog/list-view.tsx"
import { modelName } from "./format.ts"

export const pickerModel = (provider: AgentKindId, id: string, ref: ModelRef, rows: ModelRow[]): PickerModel => ({
  provider,
  id,
  ref,
  // opencode's and pi's own providers go before the model's id.
  label: ref.provider === null ? modelName(id) : `${ref.provider}/${ref.id}`,
  note: rows.find((row) => row.ref.provider === ref.provider && row.ref.id === ref.id)?.note,
})

const keyOf = (model: PickerModel) => modelKey(model.provider, model.ref)
const favorite = (model: PickerModel) => isFavorite(model.provider, model.ref)
const hidden = (model: PickerModel) => isHidden(model.provider, model.ref)

// A row's id; the same model also listed under Favorites has an id of its own there.
function lineId(line: PickerLine, section: PickerSection): string {
  if (line.kind === "more") return `more ${line.provider}`
  if (line.kind === "loading") return `loading ${line.provider}`
  return section.favorites ? `favorite ${keyOf(line.model)}` : keyOf(line.model)
}

const letter = (key: KeyEvent, name: string) => !key.ctrl && !key.meta && !key.shift && key.name === name

// /model: every added provider's models. Enter hands the model to `onPick`, which decides what picking it does.
export function ModelPicker(props: {
  groups: PickerGroup[]
  current: { provider: AgentKindId; id: string } | null
  initialQuery?: string
  onPick: (model: PickerModel) => void
  onClose: () => void
}) {
  const [showHidden, setShowHidden] = createSignal(false)
  const [expanded, setExpanded] = createSignal<ReadonlySet<AgentKindId>>(new Set())
  const isCurrent = (model: PickerModel) => {
    const now = props.current
    return now !== null && isModelOf(model, now)
  }
  const currentModel = () => props.groups.flatMap((group) => group.models ?? []).find(isCurrent)
  // Where the selection goes when its row leaves the list: the row after a hidden one, the first of an expanded rest.
  const first = untrack(currentModel)
  const [fallback, setFallback] = createSignal(first ? keyOf(first) : undefined)
  const names = () => new Map(props.groups.map((group) => [group.provider, group.name]))

  const sections = (query: string) =>
    pickerSections(props.groups, { query, showHidden: showHidden(), expanded: expanded(), favorite, hidden })

  const item = (line: PickerLine, section: PickerSection): DialogItem => {
    const id = lineId(line, section)
    if (line.kind === "loading") return { id, spans: [{ text: "Loading…", fg: theme.panelFaint }] }
    if (line.kind === "more") return { id, label: `… ${line.count} more`, labelColor: theme.panelMuted }
    const { model } = line
    return {
      id,
      label: model.label,
      note: model.note,
      tag: section.favorites ? names().get(model.provider) : undefined,
      value: isCurrent(model) ? "current" : undefined,
      marker: line.favorite ? { text: "★", fg: theme.accent } : undefined,
      labelColor: line.hidden ? theme.panelFaint : undefined,
    }
  }
  const dialogSections = (query: string): DialogSection[] =>
    sections(query).map((section) => ({
      title: section.title,
      rows: section.lines.map((line) => item(line, section)),
    }))
  const lineOf = (id: string, query: string) => {
    for (const section of sections(query))
      for (const line of section.lines) if (lineId(line, section) === id) return line
    return undefined
  }
  // The id of the row after `id`, for when `id` leaves the list.
  const after = (id: string, query: string) => {
    const ids = sections(query).flatMap((section) => section.lines.map((line) => lineId(line, section)))
    return ids[ids.indexOf(id) + 1] ?? ids[ids.indexOf(id) - 1]
  }

  return (
    <Dialog
      title="Model"
      sections={dialogSections("")}
      filter={(_, query) => dialogSections(query)}
      searchPlaceholder="type to filter"
      initialQuery={props.initialQuery}
      footer={(row, query) => {
        const line = row ? lineOf(row.id, query) : undefined
        const keys = [{ action: line?.kind === "more" ? "show all" : "pick", key: "enter", needsRow: true }]
        if (query) return keys
        if (line?.kind === "model")
          keys.push(
            { action: line.favorite ? "unfavorite" : "favorite", key: "f", needsRow: true },
            { action: line.hidden ? "unhide" : "hide", key: "h", needsRow: true },
          )
        return [...keys, { action: showHidden() ? "leave out hidden" : "show hidden", key: "." }]
      }}
      footerStyle="keys"
      view="model-picker"
      width={72}
      initialSelected={fallback()}
      onEnter={() => {}}
      onKey={(key, row, query) => {
        const line = row ? lineOf(row.id, query) : undefined
        if (key.name === "return") {
          if (line?.kind === "model") {
            props.onClose()
            props.onPick(line.model)
          } else if (line?.kind === "more") {
            setFallback(keyOf(line.next))
            setExpanded((now) => new Set([...now, line.provider]))
          }
          return true
        }
        // With a search typed, these letters go to the search.
        if (query) return false
        if (key.sequence === "." && printable(key)) {
          setShowHidden((shown) => !shown)
          return true
        }
        if (line?.kind !== "model" || !row) return false
        const toggle = letter(key, "f") ? toggleFavorite : letter(key, "h") ? toggleHidden : null
        if (!toggle) return false
        setFallback(after(row.id, query))
        toggle(line.model.provider, line.model.ref)
        return true
      }}
      onEscape={props.onClose}
    />
  )
}
