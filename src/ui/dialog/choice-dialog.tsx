import { Dialog } from "./dialog.tsx"

export type Choice = { id: string; label: string; note?: string }

// One value out of a short list, the current one marked: /model, /effort.
export function ChoiceDialog(props: {
  title: string
  choices: Choice[]
  current: string | null
  onChoose: (id: string) => void
  onClose: () => void
}) {
  return (
    <Dialog
      title={props.title}
      sections={[
        {
          title: "",
          rows: props.choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
            note: choice.note,
            value: choice.id === props.current ? "current" : undefined,
          })),
        },
      ]}
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
