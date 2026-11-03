import type { ScrollBoxRenderable } from "@opentui/core"
import { extname } from "node:path"
import { createSignal, For, Show, untrack } from "solid-js"
import { defineMod, Diff, type ModApi, theme } from "yellowcode/mod"
import { type Change, fileDiff, type GitState, readState } from "./status.ts"

const MAX_ROWS = 8
const letterColor = (letter: string) =>
  ({ M: theme.warning, A: theme.success, D: theme.error, R: theme.accent })[letter] ?? theme.muted

// Cuts a path from the left so the end, the file name, stays: "…/login.ts".
function cutPath(path: string, width: number): string {
  if (Bun.stringWidth(path) <= width) return path
  if (width <= 1) return "…"
  const kept = Array.from(path)
  while (Bun.stringWidth(kept.join("")) > width - 1) kept.shift()
  return `…${kept.join("")}`
}

function counts(change: Change): string {
  return [change.added ? `+${change.added}` : "", change.removed ? `−${change.removed}` : ""].filter(Boolean).join(" ")
}

// The file's diff in a wide dialog; ↑↓ and PgUp/PgDn scroll it. Answers whether it opened.
async function showDiff(mod: ModApi, cwd: string, change: Change): Promise<boolean> {
  const diff = await fileDiff(cwd, change)
  const dialog = mod.dialogs.open({
    title: `${change.path}  ${counts(change)}`,
    wide: true,
    hints: [{ key: "↑↓", action: "scroll" }],
    view: (props) => {
      let scroll: ScrollBoxRenderable | undefined
      const page = () => Math.max(1, untrack(() => props.height) - 2)
      untrack(() => props.onKey)((key) => {
        const step = { up: -1, down: 1, pageup: -page(), pagedown: page() }[key.name]
        if (step !== undefined) scroll?.scrollBy({ x: 0, y: step })
      })
      return (
        <scrollbox ref={(element: ScrollBoxRenderable) => (scroll = element)} width={props.width} height={props.height}>
          <Show when={diff.trim() !== ""} fallback={<text fg={theme.muted}>No changes against the last commit.</text>}>
            <Diff diff={diff} lang={extname(change.path).slice(1)} />
          </Show>
        </scrollbox>
      )
    },
  })
  if (!dialog.shown) {
    mod.notify("Close the open dialog first", { level: "info" })
    return false
  }
  await dialog.closed
  return true
}

function Row(props: { change: Change; width: number; onOpen: () => void }) {
  const added = () => (props.change.added ? ` +${props.change.added}` : "")
  const removed = () => (props.change.removed ? ` −${props.change.removed}` : "")
  const room = () => Math.max(1, props.width - 2 - Bun.stringWidth(added() + removed()))
  return (
    <text wrapMode="none" onMouseDown={() => props.onOpen()}>
      <span style={{ fg: letterColor(props.change.letter) }}>{`${props.change.letter} `}</span>
      <span style={{ fg: theme.text }}>{cutPath(props.change.path, room())}</span>
      <span style={{ fg: theme.success }}>{added()}</span>
      <span style={{ fg: theme.error }}>{removed()}</span>
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
    const open = (change: Change) =>
      void showDiff(mod, cwd, change).catch((error: unknown) => mod.log.warn("cannot show the diff", error))

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
            <For each={changes().slice(0, MAX_ROWS)}>
              {(change) => <Row change={change} width={props.width} onOpen={() => open(change)} />}
            </For>
            <Show when={hidden() > 0}>
              <text fg={theme.muted}>{`+${hidden()} more`}</text>
            </Show>
          </box>
        )
      },
    })

    // Every change, by keyboard; closing a diff comes back to the list.
    const pick = async (): Promise<void> => {
      await refresh()
      if (state() === null) return mod.notify("Not a git repository", { level: "info" })
      if (changes().length === 0) return mod.notify("No changes", { level: "info" })
      const id = await mod.dialogs.choose({
        title: "Changed files",
        items: changes().map((change) => ({
          id: change.path,
          label: `${change.letter} ${change.path}`,
          note: counts(change) || undefined,
        })),
      })
      const change = changes().find((item) => item.path === id)
      if (change && (await showDiff(mod, cwd, change))) await pick()
    }
    mod.commands.add({
      name: "git",
      description: "List the changed files and show a diff",
      run: () => void pick().catch((error: unknown) => mod.log.warn("cannot list the changes", error)),
    })

    const update = () => void refresh().catch((error: unknown) => mod.log.warn("cannot read git", error))
    mod.events.on("tool-done", update)
    mod.events.on("turn-end", update)
    mod.events.on("focus", update)
    update()
  },
})
