import { Dialog } from "./dialog.tsx"

export type Choice = { id: string; label: string; note?: string }

// A heading and its choices; one group shows no heading.
export type ChoiceGroup = { title: string; choices: Choice[] }

// One value out of a short list, the current one marked: /model, /effort.
export function ChoiceDialog(props: {
  title: string
  groups: ChoiceGroup[]
  current: string | null
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
        })),
      }))}
      footer={[
        { action: "Choose", key: "enter", needsRow: true },
        { action: "Cancel", key: "esc" },
      ]}
      search={false}
      view={`choice-${props.title}`}
      initialSelected={props.current ?? undefined}
      onEnter={(row) => {
        props.onChoose(row.id)
        props.onClose()
      }}
      onKey={() => false}
      onEscape={props.onClose}
    />
  )
}
