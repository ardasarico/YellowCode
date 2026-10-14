import { createSignal, Show } from "solid-js"
import { shellEndText } from "../session/shells.ts"
import type { Session, ShellEnd, Task } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { cut } from "./format.ts"

function endColor(task: Task) {
  if (task.state === "failed") return theme.error
  if (task.state === "stopped") return theme.warning
  return theme.muted
}

export function ShellEndRow(props: { session: Session; item: ShellEnd; onOpen: (taskId: string) => void }) {
  const [width, setWidth] = createSignal(0)
  const task = () => props.session.tasks[props.item.taskId]

  return (
    <box
      id={props.item.id}
      onSizeChange={function () {
        setWidth(this.width)
      }}
      onMouseDown={(event) => {
        event.preventDefault()
        props.onOpen(props.item.taskId)
      }}
    >
      <Show when={task()}>
        {(shell) => (
          <text wrapMode="none" fg={endColor(shell())}>
            {cut(`● ${shellEndText(shell())}`, width())}
          </text>
        )}
      </Show>
    </box>
  )
}
