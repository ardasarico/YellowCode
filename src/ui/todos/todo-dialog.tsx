import { todoList } from "../../session/todos.ts"
import type { Session } from "../../session/types.ts"
import { Dialog } from "../dialog/dialog.tsx"
import { todoMark } from "./todo-row.tsx"

export function TodoDialog(props: { session: Session; onClose: () => void }) {
  const rows = () =>
    todoList(props.session).map((todo) => ({ id: todo.id, label: todo.text, marker: todoMark(todo.state) }))
  const done = () => todoList(props.session).filter((todo) => todo.state === "done").length
  return (
    <Dialog
      title={`Tasks ${done()}/${todoList(props.session).length}`}
      sections={[{ title: "", rows: rows() }]}
      search={false}
      footer={[{ key: "esc", action: "close" }]}
      footerStyle="keys"
      view="tasks"
      onEnter={() => {}}
      onKey={() => false}
      onEscape={props.onClose}
    />
  )
}
