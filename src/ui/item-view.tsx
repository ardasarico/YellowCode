import type { MarkdownTableOptions } from "@opentui/core"
import { Match, Show, Switch } from "solid-js"
import type { Item } from "../session/types.ts"
import { syntaxStyle, theme } from "../theme/theme.ts"
import { ToolCallView } from "./tool-call-view.tsx"

export type ItemViewProps = {
  item: Item
  selected: boolean
  expanded: boolean
  onToggle: (id: string) => void
}

const TABLE_OPTIONS: MarkdownTableOptions = { style: "grid" }

function hasKind<K extends Item["kind"]>(item: Item, kind: K): item is Extract<Item, { kind: K }> {
  return item.kind === kind
}

function as<K extends Item["kind"]>(item: Item, kind: K): Extract<Item, { kind: K }> | undefined {
  return hasKind(item, kind) ? item : undefined
}

function formatTurnEnd(item: Extract<Item, { kind: "turn-end" }>): string {
  return `$${item.costUsd.toFixed(4)} · ${(item.durationMs / 1000).toFixed(1)}s · ${item.inputTokens} in / ${item.outputTokens} out`
}

export function ItemView(props: ItemViewProps) {
  return (
    <Switch>
      <Match when={as(props.item, "user")}>
        {(item) => (
          <box marginTop={1} flexDirection="column">
            <text fg={theme.accent}>{`> ${item().text}`}</text>
            <Show when={item().imageCount > 0}>
              <text fg={theme.muted}>
                {Array.from({ length: item().imageCount }, (_, index) => `[image ${index + 1}]`).join(" ")}
              </text>
            </Show>
          </box>
        )}
      </Match>
      <Match when={as(props.item, "text")}>
        {(item) => (
          <box marginTop={1}>
            <markdown
              content={item().markdown}
              syntaxStyle={syntaxStyle}
              streaming={item().streaming}
              conceal
              fg={theme.text}
              // The default "coalesced" mode re-renders the whole message on every delta, which flashes heading markers.
              internalBlockMode="top-level"
              tableOptions={TABLE_OPTIONS}
            />
          </box>
        )}
      </Match>
      <Match when={as(props.item, "thinking")}>
        {(item) => <text fg={theme.muted}>{item().streaming ? "∴ Thinking…" : "∴ Thought"}</text>}
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
      <Match when={as(props.item, "turn-end")}>
        {(item) => <text fg={item().error ? theme.error : theme.muted}>{item().error ?? formatTurnEnd(item())}</text>}
      </Match>
      <Match when={as(props.item, "system")}>
        {(item) => <text fg={item().level === "warning" ? theme.warning : theme.muted}>{`· ${item().text}`}</text>}
      </Match>
    </Switch>
  )
}
