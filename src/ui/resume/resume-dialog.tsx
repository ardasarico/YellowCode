import { createSignal, onMount } from "solid-js"
import { log } from "../../log/log.ts"
import type { SessionEntry } from "../../agent/sessions.ts"
import { theme } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import { NO_PROMPT } from "../format.ts"
import { rowEnd, type SessionList } from "./rows.ts"

// Sessions of different agents may share an id.
const rowId = (entry: SessionEntry) => `${entry.ref.agent}:${entry.ref.id}`

export type ResumeSessions = { list(): Promise<SessionList>; open(entry: SessionEntry): void }

export function ResumeDialog(props: { sessions: ResumeSessions; onClose: () => void }) {
  const [list, setList] = createSignal<SessionList | null>(null)
  const [failed, setFailed] = createSignal(false)
  onMount(() => {
    props.sessions
      .list()
      .then(setList)
      .catch((error: unknown) => {
        log.warn("sessions could not be read", String(error))
        setFailed(true)
        setList({ entries: [], names: null })
      })
  })

  const entries = () => list()?.entries ?? null
  const sections = () => {
    const shown = list() ?? { entries: [], names: null }
    const end = rowEnd(shown, Date.now())
    return [
      {
        title: "",
        rows: shown.entries.map((entry) => ({
          id: rowId(entry),
          label: entry.title || NO_PROMPT,
          labelColor: entry.title ? undefined : theme.panelMuted,
          value: end(entry),
          search: `${entry.title}\n${entry.firstPrompt}`,
        })),
      },
    ]
  }

  return (
    <Dialog
      title="Resume"
      width={72}
      sections={sections()}
      footer={[
        { action: "Open", key: "enter", needsRow: true },
        { action: "Search", key: "type" },
      ]}
      view="resume"
      onEnter={(row) => {
        const entry = entries()?.find((candidate) => rowId(candidate) === row.id)
        if (!entry) return
        props.sessions.open(entry)
        props.onClose()
      }}
      onKey={() => false}
      onEscape={props.onClose}
      empty={(query) => {
        if (entries() === null) return "Reading the sessions…"
        if (failed()) return "Could not read the sessions"
        return query === "" ? "No sessions in this project." : `No sessions match "${query}".`
      }}
    />
  )
}
