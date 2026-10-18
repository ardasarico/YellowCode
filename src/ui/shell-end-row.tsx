import { createSignal, Show } from "solid-js"
import { shellEndStatus } from "../session/shells.ts"
import type { Session, ShellEnd, Task } from "../session/types.ts"
import { theme } from "../theme/theme.ts"
import { cut } from "./format.ts"

// The status and exit code always show; the command's description is cut to make room for them.
function endText(task: Task, width: number): string {
  const status = shellEndStatus(task)
  const room = width - Bun.stringWidth(`● Background command ""${status}`)
  const label = task.description || task.command
  if (room < 2) return cut(`● Background command "${label}"${status}`, width)
  return `● Background command "${cut(label, room)}"${status}`
}

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
            {endText(shell(), width())}
          </text>
        )}
      </Show>
    </box>
  )
}
