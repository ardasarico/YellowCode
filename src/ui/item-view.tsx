import { useTerminalDimensions } from "@opentui/solid"
import { Match, Switch } from "solid-js"
import type { Item } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { Markdown } from "./markdown/markdown.tsx"
import { ToolCallView } from "./tool-call-view.tsx"

export type ItemViewProps = {
  item: Item
  selected: boolean
  expanded: boolean
  onToggle: (id: string) => void
}

function hasKind<K extends Item["kind"]>(item: Item, kind: K): item is Extract<Item, { kind: K }> {
  return item.kind === kind
}

function as<K extends Item["kind"]>(item: Item, kind: K): Extract<Item, { kind: K }> | undefined {
  return hasKind(item, kind) ? item : undefined
}

export function ItemView(props: ItemViewProps) {
  const dimensions = useTerminalDimensions()
  return (
    <Switch>
      <Match when={as(props.item, "text")}>
        {(item) => (
          <box>
            <Markdown markdown={item().markdown} streaming={item().streaming} width={dimensions().width - 2} />
          </box>
        )}
      </Match>
      <Match when={as(props.item, "tool")}>
        {(item) => (
          <ToolCallView item={item()} selected={props.selected} expanded={props.expanded} onToggle={props.onToggle} />
        )}
      </Match>
      <Match when={as(props.item, "permission")}>
        {(item) => (
          <text fg={theme.warning}>{`? Permission: ${item().toolName} ${item().summary} → ${item().decision}`}</text>
        )}
      </Match>
    </Switch>
  )
}
