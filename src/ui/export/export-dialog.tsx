import { createSignal, untrack } from "solid-js"
import { Dialog } from "../dialog/dialog.tsx"
import { printable } from "../dialog/list-view.tsx"

const ACTIONS = [
  { id: "copy", label: "Copy to clipboard", value: "as Markdown" },
  { id: "file", label: "Save to file", value: "in this project" },
]

// Copy the conversation, or name the file it goes to.
export function ExportDialog(props: {
  fileName: string
  onCopy: () => void
  onSave: (name: string) => void
  onClose: () => void
}) {
  const [naming, setNaming] = createSignal(false)
  // Back from the file name, Save stays selected.
  const [cameBack, setCameBack] = createSignal(false)
  const [name, setName] = createSignal(untrack(() => props.fileName))
  return (
    <Dialog
      title={naming() ? "Export conversation › Save to file" : "Export conversation"}
      sections={
        naming()
          ? [{ title: "File name", rows: [{ id: "save", label: `${name()}▏` }] }]
          : [{ title: "", rows: ACTIONS }]
      }
      search={false}
      footer={
        naming()
          ? [
              { key: "enter", action: "save" },
              { key: "esc", action: "back" },
            ]
          : [
              { key: "↑↓", action: "select" },
              { key: "enter", action: "choose", needsRow: true },
              { key: "esc", action: "close" },
            ]
      }
      footerStyle="keys"
      view={naming() ? "file" : "actions"}
      initialSelected={naming() ? "save" : cameBack() ? "file" : "copy"}
      onEnter={(row) => {
        if (naming()) {
          if (name().trim()) props.onSave(name().trim())
        } else if (row.id === "copy") props.onCopy()
        else setNaming(true)
      }}
      onKey={(key) => {
        if (!naming()) return false
        if (key.name === "backspace") {
          setName((text) => text.slice(0, -1))
          return true
        }
        if (printable(key)) {
          setName((text) => text + key.sequence)
          return true
        }
        return false
      }}
      onEscape={() => {
        if (!naming()) return props.onClose()
        setCameBack(true)
        setNaming(false)
      }}
    />
  )
}
