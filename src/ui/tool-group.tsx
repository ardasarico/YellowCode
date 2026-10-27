import { RGBA } from "@opentui/core"
import { For, Index, Match, Show, Switch } from "solid-js"
import type { Ask, ItemId, Session } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { FoldHint } from "./fold-hint.tsx"
import { groupLabel } from "./structure.ts"
import { ThinkingRow } from "./thinking.tsx"
import { ToolCallRow } from "./tool-call.tsx"

const CLEAR = RGBA.fromValues(0, 0, 0, 0)

export function ToolGroupRow(props: {
  session: Session
  id: string
  members: ItemId[]
  cwd: string
  selection: string | null
  expanded: Record<string, boolean>
  askOf: (id: string) => Ask | null
  onToggle: (id: string) => void
}) {
  const label = () => groupLabel(props.session, props.members)
  const open = () => props.expanded[props.id] === true
  return (
    <box flexDirection="column">
      <box
        id={props.id}
        alignSelf="flex-start"
        backgroundColor={(props.selection === props.id ? theme.selection : null) ?? CLEAR}
        onMouseDown={(event) => {
          event.preventDefault()
          props.onToggle(props.id)
        }}
      >
        <text wrapMode="none">
          <Index each={label().text.split(/(\d+)/)}>
            {(part, index) => (
              <span style={index % 2 === 1 ? { fg: theme.text, bold: true } : { fg: theme.muted }}>{part()}</span>
            )}
          </Index>
          <Show when={label().failed > 0}>
            <span style={{ fg: theme.muted }}> · </span>
            <span style={{ fg: theme.error }}>{`${label().failed} failed`}</span>
          </Show>
          <FoldHint open={open()} selected={props.selection === props.id} gap=" · " />
        </text>
      </box>
      <Show when={open()}>
        <box flexDirection="column" paddingLeft={2}>
          <For each={props.members}>
            {(id) => {
              const tool = () => {
                const found = props.session.byId[id]
                return found?.kind === "tool" ? found : undefined
              }
              const thinking = () => {
                const found = props.session.byId[id]
                return found?.kind === "thinking" ? found : undefined
              }
              return (
                <Switch>
                  <Match when={tool()}>
                    {(call) => (
                      <ToolCallRow
                        item={call()}
                        ask={props.askOf(id)}
                        cwd={props.cwd}
                        selected={props.selection === id}
                        expanded={props.expanded[id] === true}
                        selection={props.selection}
                        brief
                        onToggle={props.onToggle}
                      />
                    )}
                  </Match>
                  <Match when={thinking()}>
                    {(thought) => (
                      <ThinkingRow
                        item={thought()}
                        selected={props.selection === id}
                        expanded={props.expanded[id] === true}
                        onToggle={props.onToggle}
                      />
                    )}
                  </Match>
                </Switch>
              )
            }}
          </For>
        </box>
      </Show>
    </box>
  )
}
