import { createSignal, For, Show } from "solid-js"
import { defineMod } from "yellowcode/mod"
import { type Change, type GitState, readState } from "./status.ts"

const MAX_ROWS = 8
const MUTED = "#808080"
const ADDED = "#6fcf97"
const REMOVED = "#eb5757"
const LETTERS: Record<string, string> = { M: "#e2b93d", A: ADDED, D: REMOVED, R: "#5ab8ff" }

// Cuts a path from the left so the end, the file name, stays: "…/login.ts".
function cutPath(path: string, width: number): string {
  if (Bun.stringWidth(path) <= width) return path
  if (width <= 1) return "…"
  let kept = path
  while (Bun.stringWidth(kept) > width - 1) kept = kept.slice(1)
  return `…${kept}`
}

function Row(props: { change: Change; width: number }) {
  const added = () => (props.change.added ? ` +${props.change.added}` : "")
  const removed = () => (props.change.removed ? ` −${props.change.removed}` : "")
  const room = () => Math.max(1, props.width - 2 - Bun.stringWidth(added() + removed()))
  return (
    <text wrapMode="none">
      <span style={{ fg: LETTERS[props.change.letter] ?? MUTED }}>{`${props.change.letter} `}</span>
      <span>{cutPath(props.change.path, room())}</span>
      <span style={{ fg: ADDED }}>{added()}</span>
      <span style={{ fg: REMOVED }}>{removed()}</span>
    </text>
  )
}

export default defineMod({
  setup(mod) {
    const cwd = process.cwd()
    const [state, setState] = createSignal<GitState | null>(null)

    // One read at a time; a refresh asked for during one runs once more after it.
    let reading = false
    let again = false
    const refresh = async (): Promise<void> => {
      if (reading) {
        again = true
        return
      }
      reading = true
      again = false
      try {
        setState(await readState(cwd))
      } finally {
        reading = false
      }
      if (again) await refresh()
    }
    const changes = () => state()?.changes ?? []

    mod.sidebar.add({
      id: "git",
      title: "Git",
      visible: () => state() !== null,
      right: () => {
        const current = state()
        if (!current) return ""
        return `${current.branch} · ${current.changes.length === 0 ? "clean" : current.changes.length}`
      },
      view: (props) => {
        const hidden = () => changes().length - MAX_ROWS
        return (
          <box flexDirection="column">
            <For each={changes().slice(0, MAX_ROWS)}>{(change) => <Row change={change} width={props.width} />}</For>
            <Show when={hidden() > 0}>
              <text fg={MUTED}>{`+${hidden()} more`}</text>
            </Show>
          </box>
        )
      },
    })

    const update = () => void refresh().catch((error: unknown) => mod.log.warn("cannot read git", error))
    mod.events.on("tool-done", update)
    mod.events.on("turn-end", update)
    mod.events.on("focus", update)
    update()
  },
})
