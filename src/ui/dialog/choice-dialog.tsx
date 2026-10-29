import { theme } from "../../theme/theme.ts"
import { Dialog } from "./dialog.tsx"

export type Choice = { id: string; label: string; note?: string }

// A heading and its choices; one group shows no heading.
export type ChoiceGroup = { title: string; choices: Choice[] }

// One value out of a short list, the current one marked: /model, /effort. With `favorites`, Space stars a choice.
export function ChoiceDialog(props: {
  title: string
  groups: ChoiceGroup[]
  current: string | null
  favorites?: { has: (id: string) => boolean; toggle: (id: string) => void }
  onChoose: (id: string) => void
  onClose: () => void
}) {
  return (
    <Dialog
      title={props.title}
      sections={props.groups.map((group) => ({
        title: group.title,
        rows: group.choices.map((choice) => ({
          id: choice.id,
          label: choice.label,
          note: choice.note,
          value: choice.id === props.current ? "current" : undefined,
          marker: props.favorites?.has(choice.id) ? { text: "★", fg: theme.accent } : undefined,
        })),
      }))}
      footer={[
        { action: "Choose", key: "enter", needsRow: true },
        ...(props.favorites ? [{ action: "Favorite", key: "space", needsRow: true }] : []),
        { action: "Cancel", key: "esc" },
      ]}
      search={false}
      view={`choice-${props.title}`}
      initialSelected={props.current ?? undefined}
      onEnter={(row) => {
        props.onChoose(row.id)
        props.onClose()
      }}
      onKey={(key, row) => {
        if (key.name !== "space" || !props.favorites || !row) return false
        props.favorites.toggle(row.id)
        return true
      }}
      onEscape={props.onClose}
    />
  )
}
