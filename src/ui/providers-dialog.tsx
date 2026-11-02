import { createSignal, onMount } from "solid-js"
import type { AgentKindId } from "../agent/ids.ts"
import { addProvider, removeProvider, settings } from "../session/settings.ts"
import { theme } from "../theme/theme.ts"
import { Dialog } from "./dialog/dialog.tsx"
import type { DialogRow } from "./dialog/list.ts"

// An installed provider. `blocked` says why YellowCode cannot run this version.
export type ProviderChoice = { id: AgentKindId; name: string; version: string; blocked: string | null }

const added = (id: AgentKindId) => (settings.providers ?? []).includes(id)

function rowOf(choice: ProviderChoice, inUse: AgentKindId): DialogRow {
  const row: DialogRow = {
    id: choice.id,
    label: choice.name,
    tag: choice.version,
    value: choice.blocked ?? (choice.id === inUse ? "in use" : undefined),
    valueColor: choice.blocked === null ? undefined : theme.warning,
  }
  if (added(choice.id)) return row
  return {
    ...row,
    marker: { text: "◯", fg: theme.panelFaint },
    labelColor: theme.panelFaint,
    valueColor: choice.blocked === null ? theme.panelFaint : theme.warning,
  }
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

// /providers: space adds or removes an installed provider; the one in use and the last one stay.
export function ProvidersDialog(props: {
  inUse: AgentKindId
  // Looks for the installed providers again; never rejects.
  detect: () => Promise<ProviderChoice[]>
  onClose: () => void
}) {
  const [choices, setChoices] = createSignal<ProviderChoice[] | null>(null)
  const [notice, setNotice] = createSignal("")
  onMount(() => void props.detect().then(setChoices))
  const toggle = (choice: ProviderChoice) => {
    if (added(choice.id)) setNotice(sentence(removeProvider(choice.id, props.inUse) ?? ""))
    else if (choice.blocked !== null) setNotice(`${choice.name} ${choice.blocked}`)
    else {
      addProvider(choice.id)
      setNotice("")
    }
  }
  return (
    <Dialog
      title="Providers"
      sections={(() => {
        const found = choices()
        if (!found)
          return [
            { title: "", rows: [{ id: "looking", spans: [{ text: "Looking for providers…", fg: theme.panelMuted }] }] },
          ]
        return [{ title: "", rows: found.map((choice) => rowOf(choice, props.inUse)) }]
      })()}
      footer={[
        { action: "add/remove", key: "space", needsRow: true },
        { action: "close", key: "esc" },
      ]}
      footerStyle="keys"
      notice={notice()}
      search={false}
      view="providers"
      initialSelected={props.inUse}
      onEnter={() => {}}
      onKey={(key, row) => {
        if (key.name !== "space") return false
        const choice = choices()?.find((one) => one.id === row?.id)
        if (choice) toggle(choice)
        return true
      }}
      onEscape={props.onClose}
    />
  )
}
