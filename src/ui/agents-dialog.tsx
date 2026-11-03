import { createSignal, Show } from "solid-js"
import type { PickerGroup, PickerModel } from "../models/picker.ts"
import { type Definition, fileOf, loadDefinitions, writeModel } from "../subagents/definitions.ts"
import { modelText } from "../subagents/children.ts"
import { theme } from "../theme/theme.ts"
import { Dialog } from "./dialog/dialog.tsx"
import { openFile } from "./dialog/open-file.ts"
import type { DialogRow } from "./dialog/list.ts"
import { ModelPicker } from "./model-picker.tsx"

const named = (model: PickerModel, text: string) => modelText(model.ref) === text || model.ref.id === text

const problem = (error: unknown) => (error instanceof Error ? error.message : String(error))

// /agents: the subagent definitions and the model each runs on. Enter picks a model into the agent's file.
export function AgentsDialog(props: {
  cwd: string
  // The added providers' models; a group still being listed has none yet.
  groups: PickerGroup[]
  onClose: () => void
}) {
  const read = () => loadDefinitions(props.cwd, () => false)
  const [definitions, setDefinitions] = createSignal(read())
  const [picking, setPicking] = createSignal<Definition | null>(null)
  const [notice, setNotice] = createSignal("")
  const [selected, setSelected] = createSignal<string | undefined>()

  const groupOf = (agent: Definition) => props.groups.find((group) => group.provider === agent.provider)
  const modelOf = (agent: Definition) =>
    agent.model === null ? undefined : groupOf(agent)?.models?.find((model) => named(model, agent.model ?? ""))

  const rowOf = (agent: Definition): DialogRow => {
    const group = groupOf(agent)
    const why =
      agent.provider === null || agent.model === null
        ? "no model"
        : !group
          ? "provider removed"
          : group.models && !modelOf(agent)
            ? "model not listed"
            : null
    const row: DialogRow = {
      id: agent.name,
      label: agent.name,
      tag: agent.source,
      note: agent.description || undefined,
    }
    if (why === null)
      return { ...row, value: `${modelOf(agent)?.label ?? agent.model} · ${group?.name ?? agent.provider}` }
    return { ...row, labelColor: theme.panelFaint, value: why, valueColor: theme.panelFaint }
  }

  const pick = (agent: Definition, model: PickerModel) => {
    try {
      writeModel(agent.name, model.provider, modelText(model.ref), props.cwd)
      setNotice("")
    } catch (error) {
      setNotice(`Could not save the model: ${problem(error)}`)
    }
    setDefinitions(read())
  }

  const edit = (agent: Definition) => {
    let path: string
    try {
      path = fileOf(agent.name, props.cwd)
    } catch (error) {
      setNotice(`Could not make the file: ${problem(error)}`)
      return
    }
    setDefinitions(read())
    void openFile(path)
  }

  return (
    <Show
      when={picking()}
      keyed
      fallback={
        <Dialog
          title="Agents"
          sections={[{ title: "", rows: definitions().map(rowOf) }]}
          footer={[
            { action: "pick model", key: "enter", needsRow: true },
            { action: "edit file", key: "e", needsRow: true },
            { action: "close", key: "esc" },
          ]}
          footerStyle="keys"
          notice={notice()}
          search={false}
          view="agents"
          width={72}
          initialSelected={selected()}
          onSelect={(row) => setSelected(row.id)}
          onEnter={(row) => setPicking(definitions().find((agent) => agent.name === row.id) ?? null)}
          onKey={(key, row) => {
            if (key.name !== "e" || key.ctrl || key.meta || key.shift) return false
            const agent = definitions().find((one) => one.name === row?.id)
            if (agent) edit(agent)
            return true
          }}
          onEscape={props.onClose}
        />
      }
    >
      {(agent) => {
        const now = modelOf(agent)
        return (
          <ModelPicker
            groups={props.groups}
            current={now ? { provider: now.provider, id: now.id } : null}
            onPick={(model) => pick(agent, model)}
            onClose={() => setPicking(null)}
          />
        )
      }}
    </Show>
  )
}
