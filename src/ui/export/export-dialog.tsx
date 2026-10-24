import { createSignal, untrack } from "solid-js"
import { theme } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import { printable } from "../dialog/list-view.tsx"

const ACTIONS = [
  { id: "copy", label: "Copy to clipboard", value: "as Markdown" },
  { id: "file", label: "Save to file", value: "in this project" },
]

// Copy the conversation, or name the file it goes to.
export function ExportDialog(props: {
  fileName: string
  exists: (name: string) => boolean
  onCopy: () => void
  onSave: (name: string) => void
  onClose: () => void
}) {
  const [naming, setNaming] = createSignal(false)
  // Back from the file name, Save stays selected.
  const [cameBack, setCameBack] = createSignal(false)
  const [name, setName] = createSignal(untrack(() => props.fileName))
  // The existing file a second Enter replaces.
  const [warned, setWarned] = createSignal<string | null>(null)
  const rename = (next: (text: string) => string) => {
    setWarned(null)
    setName(next)
  }
  return (
    <Dialog
      title={naming() ? "Export conversation › Save to file" : "Export conversation"}
      sections={
        naming()
          ? [{ title: "File name", rows: [{ id: "save", label: `${name()}▏` }] }]
          : [{ title: "", rows: ACTIONS }]
      }
      pinned={
        warned()
          ? [{ id: "exists", spans: [{ text: `${warned()} exists · enter replaces it`, fg: theme.warning }] }]
          : []
      }
      search={false}
      footer={
        naming()
          ? [
              { key: "enter", action: warned() ? "replace" : "save" },
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
          const chosen = name().trim()
          if (!chosen) return
          if (warned() !== chosen && props.exists(chosen)) setWarned(chosen)
          else props.onSave(chosen)
        } else if (row.id === "copy") props.onCopy()
        else setNaming(true)
      }}
      onKey={(key) => {
        if (!naming()) return false
        if (key.name === "backspace") {
          rename((text) => text.slice(0, -1))
          return true
        }
        if (printable(key)) {
          rename((text) => text + key.sequence)
          return true
        }
        return false
      }}
      onEscape={() => {
        if (!naming()) return props.onClose()
        setCameBack(true)
        setWarned(null)
        setNaming(false)
      }}
    />
  )
}
