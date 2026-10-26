import { createSignal, onMount } from "solid-js"
import { log } from "../../log/log.ts"
import { NO_PROMPT, type SessionEntry } from "../../resume/session-list.ts"
import { theme } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import { formatAgo } from "../format.ts"

export type ResumeSessions = { list(): Promise<SessionEntry[]>; open(entry: SessionEntry): void }

export function ResumeDialog(props: { sessions: ResumeSessions; onClose: () => void }) {
  const [entries, setEntries] = createSignal<SessionEntry[] | null>(null)
  const [failed, setFailed] = createSignal(false)
  onMount(() => {
    props.sessions
      .list()
      .then(setEntries)
      .catch((error: unknown) => {
        log.warn("sessions could not be read", String(error))
        setFailed(true)
        setEntries([])
      })
  })

  const sections = () => {
    const now = Date.now()
    return [
      {
        title: "",
        rows: (entries() ?? []).map((entry) => ({
          id: entry.id,
          label: entry.title || NO_PROMPT,
          labelColor: entry.title ? undefined : theme.panelMuted,
          value: formatAgo(entry.modified, now),
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
        const entry = entries()?.find((candidate) => candidate.id === row.id)
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
