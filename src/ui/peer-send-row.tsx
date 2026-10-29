import { Index, Show } from "solid-js"
import { z } from "zod"
import { PEER_SERVER, readResultLine } from "../peers/tools.ts"
import type { ToolCall } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { agentColor } from "./agent-color.ts"
import { FoldHint } from "./fold-hint.tsx"
import { printable } from "./format.ts"

const RESULT_INDENT = "  ⎿  "

export const isPeerSend = (tool: ToolCall) =>
  tool.server === PEER_SERVER && (tool.title === "send" || tool.title === "broadcast")

const INPUT = z.looseObject({
  to: z.string().optional(),
  message: z.string().optional(),
  everywhere: z.boolean().optional(),
})

// A message the model sent to other sessions: one line with whom it went to, the whole text once opened.
export function PeerSendRow(props: { item: ToolCall; selected: boolean; expanded: boolean }) {
  const broadcast = () => props.item.title === "broadcast"
  const lines = () => props.item.result.split("\n").filter((line) => line.trim() !== "")
  const targets = () => lines().map((line) => ({ line, read: readResultLine(line) }))
  const first = () => targets()[0]?.read ?? null
  const input = () => INPUT.safeParse(props.item.input).data
  const message = () => printable(input()?.message ?? "")
  const hidden = () => message().split("\n").length - 1
  const foldable = () => hidden() > 0 || message().length > 80
  const color = () => (broadcast() ? theme.accent : agentColor(first()?.agent ?? ""))
  const head = () => {
    if (broadcast()) return input()?.everywhere ? "→ every session" : "→ this project"
    const target = first()
    return target ? `→ ${target.title} · ${target.agent}` : `→ ${input()?.to ?? ""}`
  }
  const statusColor = () => (props.item.status === "error" ? theme.error : theme.muted)

  return (
    <box
      id={props.item.id}
      flexDirection="column"
      backgroundColor={(props.selected ? theme.selection : null) ?? undefined}
    >
      <Show
        when={props.expanded}
        fallback={
          <text wrapMode="none">
            <span style={{ fg: color() }}>{`${head()}  `}</span>
            <span style={{ fg: theme.text }}>{message().split("\n")[0] ?? ""}</span>
          </text>
        }
      >
        <text fg={color()} wrapMode="none">
          {head()}
        </text>
        <box paddingLeft={2}>
          <text fg={theme.text} wrapMode="word">
            {message()}
          </text>
        </box>
      </Show>
      <Show
        when={props.item.status !== "running"}
        fallback={<text fg={theme.muted}>{`${RESULT_INDENT}sending…`}</text>}
      >
        <Index each={broadcast() ? targets() : targets().slice(0, 1)}>
          {(target, index) => (
            <text wrapMode="none">
              <span style={{ fg: statusColor() }}>
                {`${RESULT_INDENT}${
                  broadcast() && target().read
                    ? `${target().read?.title} · ${target().read?.agent}: ${target().read?.status}`
                    : (target().read?.status ?? target().line)
                }`.replace(/\.$/, "")}
              </span>
              <Show when={index === 0 && foldable()}>
                <FoldHint open={props.expanded} selected={props.selected} hidden={hidden()} gap=" · " />
              </Show>
            </text>
          )}
        </Index>
      </Show>
    </box>
  )
}
