import { join } from "node:path"
import { createSignal, Show } from "solid-js"
import { forgetMemory, listMemories, MAX_MEMORIES, type Memory, writeIndex } from "../memory/store.ts"
import { canUndoTidy, undoTidy } from "../memory/tidy.ts"
import { theme } from "../theme/theme.ts"
import { CodeView } from "./dialog/code-view.tsx"
import { Dialog } from "./dialog/dialog.tsx"
import type { DialogRow } from "./dialog/list.ts"
import { openFile } from "./dialog/open-file.ts"
import { formatAgo } from "./format.ts"

// /memory: the project's memories. Enter shows one in full, `e` opens its file, `d` twice deletes it, `t` runs a
// tidy-up and `u` takes the last one back.
export function MemoryDialog(props: {
  folder: string
  onClose: () => void
  onCopy: (text: string) => Promise<boolean>
  // Runs a tidy-up and resolves to the line that says how it went.
  onTidy: () => Promise<string>
}) {
  // A file changed in an editor since the last look counts from here on.
  const read = () => {
    writeIndex(props.folder)
    return listMemories(props.folder)
  }
  const [memories, setMemories] = createSignal(read())
  const [shown, setShown] = createSignal<Memory | null>(null)
  const [selected, setSelected] = createSignal<string | undefined>()
  const [deleting, setDeleting] = createSignal<string | null>(null)
  const [said, setSaid] = createSignal("")
  const canUndo = () => canUndoTidy(props.folder)
  const [undoable, setUndoable] = createSignal(canUndo())
  let tidying = false
  const refresh = () => {
    setMemories(read())
    setUndoable(canUndo())
  }
  const tidyUp = () => {
    if (tidying) return
    tidying = true
    setSaid("Tidying up…")
    void props.onTidy().then((line) => {
      tidying = false
      setSaid(line.split(" · ")[0] ?? line)
      refresh()
    })
  }
  const now = Date.now()

  const rowOf = (memory: Memory): DialogRow => ({
    id: memory.name,
    label: memory.name,
    tag: memory.type,
    note: memory.description || undefined,
    value: formatAgo(memory.modified, now),
    search: `${memory.name} ${memory.description}`,
  })
  const find = (row: DialogRow | undefined) => memories().find((memory) => memory.name === row?.id)

  return (
    <Show
      when={shown()}
      keyed
      fallback={
        <Dialog
          title={`Memory · ${memories().length} of ${MAX_MEMORIES}`}
          sections={[{ title: "", rows: memories().map(rowOf) }]}
          footer={[
            { action: "open", key: "enter", needsRow: true },
            { action: "edit", key: "e", needsRow: true },
            { action: "delete", key: "d", needsRow: true },
            { action: "tidy up", key: "t" },
            ...(undoable() ? [{ action: "undo", key: "u" }] : []),
            { action: "close", key: "esc" },
          ]}
          footerStyle="keys"
          notice={deleting() ? "d again to delete" : undefined}
          pinned={said() ? [{ id: "said", spans: [{ text: said(), fg: theme.panelMuted }] }] : []}
          search={false}
          view="memory"
          width={96}
          initialSelected={selected()}
          empty={() => "No memories yet. Your agent saves them as it learns about you and the project."}
          onSelect={(row) => {
            setSelected(row.id)
            if (deleting() !== row.id) setDeleting(null)
          }}
          onEnter={(row) => setShown(find(row) ?? null)}
          onKey={(key, row) => {
            if (key.ctrl || key.meta || key.shift) return false
            if (key.name === "t") {
              tidyUp()
              return true
            }
            if (key.name === "u" && undoable()) {
              undoTidy(props.folder)
              setSaid("Tidy-up taken back")
              refresh()
              return true
            }
            const memory = find(row)
            if (!memory) return false
            if (key.name === "e") {
              void openFile(join(props.folder, `${memory.name}.md`))
              return true
            }
            if (key.name !== "d") return false
            if (deleting() !== memory.name) {
              setDeleting(memory.name)
              return true
            }
            forgetMemory(props.folder, memory.name)
            setDeleting(null)
            refresh()
            return true
          }}
          onEscape={props.onClose}
        />
      }
    >
      {(memory) => (
        <CodeView
          refs={[{ path: `${memory.name}.md`, text: `${memory.description}\n\n${memory.body}\n` }]}
          index={0}
          onIndex={() => {}}
          onClose={() => setShown(null)}
          onCopy={props.onCopy}
        />
      )}
    </Show>
  )
}
