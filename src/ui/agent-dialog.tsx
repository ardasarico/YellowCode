import { createSignal, onMount } from "solid-js"
import type { AgentKindId } from "../agent/ids.ts"
import { theme } from "../theme/theme.ts"
import { Dialog } from "./dialog/dialog.tsx"
import type { DialogItem } from "./dialog/list.ts"

// An installed agent. `blocked` says why YellowCode cannot run this version.
export type AgentChoice = { id: AgentKindId; name: string; version: string; blocked: string | null }

// A blocked agent is listed with why, and cannot be picked.
const rowOf = (choice: AgentChoice, current: AgentKindId): DialogItem =>
  choice.blocked === null
    ? {
        id: choice.id,
        label: choice.name,
        tag: choice.version,
        value: choice.id === current ? "current" : undefined,
      }
    : {
        id: `blocked-${choice.id}`,
        spans: [{ text: `  ${choice.name} ${choice.version} · ${choice.blocked}`, fg: theme.warning }],
      }

// /agent: another agent starts a new session in place of this one.
export function AgentDialog(props: {
  current: AgentKindId
  // Looks for the installed agents again; never rejects.
  detect: () => Promise<AgentChoice[]>
  onPick: (id: AgentKindId) => void
  onClose: () => void
}) {
  const [choices, setChoices] = createSignal<AgentChoice[] | null>(null)
  onMount(() => void props.detect().then(setChoices))
  return (
    <Dialog
      title="Agent"
      sections={(() => {
        const found = choices()
        if (!found)
          return [
            { title: "", rows: [{ id: "looking", spans: [{ text: "Looking for agents…", fg: theme.panelMuted }] }] },
          ]
        return [{ title: "", rows: found.map((choice) => rowOf(choice, props.current)) }]
      })()}
      footer={[
        { action: "Choose", key: "enter", needsRow: true },
        { action: "Cancel", key: "esc" },
      ]}
      search={false}
      view="agent"
      initialSelected={props.current}
      onEnter={(row) => {
        if (row.id !== props.current) props.onPick(row.id)
        props.onClose()
      }}
      onKey={() => false}
      onEscape={props.onClose}
    />
  )
}
