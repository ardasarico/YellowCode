import { createSignal, Show } from "solid-js"
import { type Todo, type TodoChange, todoChange } from "../../session/todos.ts"
import type { Session, ToolCall } from "../../session/types.ts"
import { theme } from "../../theme/theme.ts"
import { cut } from "../format.ts"

export const todoMark = (state: Todo["state"]) =>
  state === "done"
    ? { text: "✔", fg: theme.success }
    : state === "active"
      ? { text: "◐", fg: theme.accent }
      : { text: "○", fg: theme.muted }

const changeMark = (change: Exclude<TodoChange, { kind: "planned" }>) =>
  todoMark(change.kind === "finished" ? "done" : change.kind === "started" ? "active" : "pending")

const planned = (change: TodoChange) => (change.kind === "planned" ? change.count : 0)

// One line per change to Claude's task list; the whole list is in the sidebar, and Enter opens it here too.
export function TodoRow(props: { session: Session; item: ToolCall; selected: boolean }) {
  const [width, setWidth] = createSignal(0)
  const change = () => todoChange(props.session, props.item.id)
  return (
    <box
      id={props.item.id}
      backgroundColor={props.selected ? (theme.selection ?? undefined) : undefined}
      onSizeChange={function () {
        setWidth(this.width)
      }}
    >
      <Show when={change()}>
        {(now) => {
          const line = () => {
            const value = now()
            if (value.kind === "planned") return null
            const more = value.more > 0 ? ` +${value.more}` : ""
            return { mark: changeMark(value), text: cut(value.text, width() - 2 - more.length), more }
          }
          return (
            <Show
              when={line()}
              fallback={
                <text wrapMode="none">
                  <span style={{ fg: theme.muted }}>● </span>
                  <span style={{ fg: theme.text, bold: true }}>Tasks</span>
                  <span style={{ fg: theme.muted }}>{` · ${planned(now())} planned`}</span>
                </text>
              }
            >
              {(shown) => (
                <text wrapMode="none">
                  <span style={{ fg: shown().mark.fg }}>{`${shown().mark.text} `}</span>
                  <span style={{ fg: theme.text }}>{shown().text}</span>
                  <span style={{ fg: theme.muted }}>{shown().more}</span>
                </text>
              )}
            </Show>
          )
        }}
      </Show>
    </box>
  )
}
