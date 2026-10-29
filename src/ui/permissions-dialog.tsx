import { createSignal } from "solid-js"
import type { Outcome } from "../agent/ids.ts"
import type { RuleRow } from "../agent/lists.ts"
import { Dialog } from "./dialog/dialog.tsx"
import type { DialogRow } from "./dialog/list.ts"

const LASTS: Record<RuleRow["lasts"], string> = {
  session: "this session",
  project: "this project",
  everywhere: "everywhere",
}

const rowOf = (rule: RuleRow): DialogRow => ({
  id: rule.id,
  label: rule.pattern === null ? rule.subject : `${rule.subject} ${rule.pattern}`,
  value: rule.effect,
  note: [LASTS[rule.lasts], rule.mode === null ? null : `in ${rule.mode}`, rule.origin].filter(Boolean).join(" · "),
})

// /permissions: the rules the agent keeps, each removable one with Delete. The list follows what the agent pushes;
// null until it pushes one.
export function PermissionsDialog(props: {
  agent: string
  rules: RuleRow[] | null
  onRemove: (id: string) => Promise<Outcome>
  onClose: () => void
}) {
  const [notice, setNotice] = createSignal<string | undefined>()
  const rules = () => props.rules ?? []
  const removable = (row: DialogRow | undefined) => rules().some((rule) => rule.id === row?.id && rule.removable)
  return (
    <Dialog
      title="Permissions"
      sections={[{ title: "", rows: rules().map(rowOf) }]}
      footer={(row) => [...(removable(row) ? [{ action: "Delete", key: "del" }] : []), { action: "Close", key: "esc" }]}
      notice={notice()}
      search={false}
      view="permissions"
      onEnter={() => {}}
      onKey={(key, row) => {
        if ((key.name !== "delete" && key.name !== "backspace") || !row || !removable(row)) return false
        setNotice(undefined)
        void props.onRemove(row.id).then((done) => {
          if (!done.ok) setNotice(done.problem)
        })
        return true
      }}
      onEscape={props.onClose}
      empty={() => (props.rules === null ? `Reading ${props.agent}'s rules…` : `${props.agent} has saved no rules.`)}
    />
  )
}
