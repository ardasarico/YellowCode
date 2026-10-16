import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, untrack } from "solid-js"
import { type RewindPoint, type Rewound, undone } from "../../session/rewind.ts"
import { theme } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import { PAD_X } from "../dialog/list-view.tsx"
import type { DialogText } from "../dialog/list.ts"
import { cut } from "../format.ts"

const WIDTH = 72

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
const flat = (text: string) => text.replace(/\s+/g, " ").trim()

// The prompts newest first; under them, one line on what rewinding to the selected one undoes, and one for files
// changed after Claude. Enter rewinds the code and the conversation, `c` only the conversation.
export function RewindDialog(props: {
  points: RewindPoint[]
  onRewind: (rewound: Rewound) => void
  onClose: () => void
}) {
  const dimensions = useTerminalDimensions()
  // The dialog's inner width, as the shared frame sizes it.
  const inner = () => (dimensions().width < WIDTH + 6 ? dimensions().width : WIDTH) - PAD_X * 2
  // The newest prompt is selected first; the points do not change while the dialog is open.
  const [selected, setSelected] = createSignal(untrack(() => props.points.at(-1)?.userId))
  const index = () => props.points.findIndex((point) => point.userId === selected())
  const files = createMemo(() => (index() < 0 ? [] : undone(props.points, index())))

  const summary = (): DialogText[] => {
    const at = index()
    if (at < 0) return []
    const prompts = plural(props.points.length - at, "prompt")
    const changed = files().length > 0 ? plural(files().length, "file") : "no file changes"
    const lines: DialogText[] = [
      { id: "gap", spans: [] },
      {
        id: "summary",
        spans: [{ text: `Goes back to before this prompt · ${prompts}, ${changed}`, fg: theme.panelMuted }],
      },
    ]
    const conflicts = files().filter((file) => file.conflict)
    const [only] = conflicts
    if (conflicts.length > 0) {
      const text =
        conflicts.length === 1 && only
          ? `⚠ ${only.path} changed after Claude`
          : `⚠ ${conflicts.length} files changed after Claude: ${conflicts.map((file) => file.path).join(", ")}`
      lines.push({ id: "conflicts", spans: [{ text: cut(text, inner()), fg: theme.warning }] })
    }
    return lines
  }

  const rewind = (keptFiles: boolean) => {
    const at = index()
    const point = props.points[at]
    if (!point) return
    props.onRewind({ userId: point.userId, prompts: props.points.length - at, files: files().length, keptFiles })
    props.onClose()
  }

  const sections = () => [
    {
      title: "",
      rows: props.points
        .toReversed()
        .map((point) => ({ id: point.userId, label: cut(flat(point.text) || "(image)", inner() - 2) })),
    },
    { title: "", rows: summary() },
  ]

  return (
    <Dialog
      title="Rewind"
      width={WIDTH}
      sections={sections()}
      footer={[
        { action: "rewind", key: "enter", needsRow: true },
        { action: "keep files", key: "c", needsRow: true },
        { action: "close", key: "esc" },
      ]}
      footerStyle="keys"
      view="rewind"
      initialSelected={selected()}
      search={false}
      onSelect={(row) => setSelected(row.id)}
      onEnter={() => rewind(false)}
      onKey={(key) => {
        if (key.name !== "c" || key.ctrl || key.meta) return false
        rewind(true)
        return true
      }}
      onEscape={props.onClose}
      empty={() => "Nothing to rewind yet."}
    />
  )
}
