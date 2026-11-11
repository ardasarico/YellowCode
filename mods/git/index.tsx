import { infoStringToFiletype, type KeyEvent } from "@opentui/core"
import { extname } from "node:path"
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js"
import { defineMod, type ModApi, syntaxStyle, theme } from "yellowcode/mod"
import {
  chunks,
  diffLines,
  type Line,
  type Notes,
  noteAt,
  noteCount,
  notesMessage,
  withNote,
  withoutStale,
} from "./notes.ts"
import { type Change, fileDiff, type GitState, readState } from "./status.ts"

const MAX_ROWS = 8
const INSERT = "\0insert"
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

// What a diff with no lines to show says: git's own words for a binary file, a rename or a mode change.
function noHunks(diff: string): string {
  if (diff.trim() === "") return "No changes against the last commit."
  if (/^Binary files /m.test(diff)) return "Binary file changed."
  const from = /^rename from (.+)$/m.exec(diff)?.[1]
  if (from) return `Renamed from ${from}, no content changes.`
  if (/^(old|new) mode /m.test(diff)) return "File mode changed, no content changes."
  return "No content changes."
}

const SIGN = { add: "+", del: "-", ctx: " " } as const
const lineColor = (kind: Line["kind"]) =>
  kind === "add" ? theme.diffAddText : kind === "del" ? theme.diffDelText : theme.muted
const plural = (count: number) => `${count} ${count === 1 ? "note" : "notes"}`
const printable = (key: KeyEvent) => {
  const code = key.sequence.charCodeAt(0)
  return !key.ctrl && !key.meta && code >= 32 && code !== 127
}

type NoteStore = { notes: () => Notes; setNotes: (change: (notes: Notes) => Notes) => void }

// The file's diff in a wide dialog, with a cursor on a line: n writes a note under it, s closes the dialog to put
// every note in the prompt. Answers how it ended; "refused" when it could not open.
async function showDiff(
  mod: ModApi,
  cwd: string,
  change: Change,
  store: NoteStore,
): Promise<"refused" | "closed" | "send"> {
  const diff = await fileDiff(cwd, change)
  const rows = diffLines(diff)
  const path = change.path
  store.setNotes((notes) => withoutStale(notes, path, rows))
  const lineAt = (index: number) => {
    const row = rows[index]
    return row && row.kind !== "gap" ? row : undefined
  }
  const digits = String(rows.reduce((most, row) => Math.max(most, row.kind === "gap" ? 0 : row.number), 0)).length
  const gutter = 2 + digits + 3
  const lang = extname(path).slice(1)
  const filetype = lang ? infoStringToFiletype(lang) : undefined
  const total = () => noteCount(store.notes())
  let send = false
  const dialog = mod.dialogs.open({
    title: `${path}  ${counts(change)}`,
    wide: true,
    hints: [
      { key: "↑↓", action: "Move" },
      { key: "n", action: "Note" },
      { key: "s", action: "Insert notes" },
    ],
    view: (props) => {
      const [cursor, setCursor] = createSignal(0)
      const [draft, setDraft] = createSignal<string | null>(null)
      const [top, setTop] = createSignal(0)
      const height = () => Math.max(1, props.height - (total() > 0 ? 1 : 0))
      const room = () => Math.max(1, props.width - gutter)
      const noteRows = (line: Line) => {
        const note = noteAt(store.notes(), path, line)
        return note ? chunks(note, Math.max(1, room() - 2)) : []
      }
      // The screen rows each diff row takes, its note or the input under it counted in.
      const heights = createMemo(() =>
        rows.map((row, at) => {
          if (row.kind === "gap") return 1
          const under = draft() !== null && cursor() === at ? 1 : noteRows(row).length
          return chunks(row.text.replaceAll("\t", "  "), room()).length + under
        }),
      )
      const span = (from: number, to: number) =>
        heights()
          .slice(from, to + 1)
          .reduce((sum, taken) => sum + taken, 0)
      // Keeps the cursor's line, with its note, on the screen.
      createEffect(() => {
        const at = cursor()
        setTop((current) => {
          let next = Math.min(current, at)
          while (next < at && span(next, at) > height()) next++
          return next
        })
      })
      const visible = () => {
        const list: number[] = []
        for (let at = top(), used = 0; at < rows.length && used < height(); used += heights()[at++] ?? 1) list.push(at)
        return list
      }

      const move = (step: number) => {
        const way = Math.sign(step)
        let next = cursor()
        for (let index = next + way, left = Math.abs(step); left > 0 && rows[index]; index += way)
          if (lineAt(index)) {
            next = index
            left--
          }
        setCursor(next)
      }
      const typing = (key: KeyEvent, text: string) => {
        const line = lineAt(cursor())
        if (key.name === "return") {
          if (line) store.setNotes((notes) => withNote(notes, path, line, text, change.from))
          setDraft(null)
        } else if (key.name === "escape") setDraft(null)
        else if (key.ctrl && key.name === "u") setDraft("")
        else if (key.name === "backspace") setDraft(Array.from(text).slice(0, -1).join(""))
        else if (printable(key)) setDraft(text + key.sequence)
      }
      // True keeps the dialog open on Esc: it only drops the note being typed.
      const pressed = (key: KeyEvent): boolean => {
        const text = draft()
        if (text !== null) {
          typing(key, text)
          return true
        }
        const page = Math.max(1, height() - 2)
        const step = { up: -1, down: 1, pageup: -page, pagedown: page }[key.name]
        const line = lineAt(cursor())
        if (step !== undefined) move(step)
        else if ((key.name === "n" || key.name === "return") && line) setDraft(noteAt(store.notes(), path, line))
        else if (key.name === "s" && total() === 0) mod.notify("No notes yet", { level: "info" })
        else if (key.name === "s") {
          send = true
          props.close()
        }
        return false
      }
      untrack(() => props.onKey)((key) => untrack(() => pressed(key)))

      // The end of a long note being typed, so the cursor stays in view.
      const typed = () => {
        const kept = Array.from(draft() ?? "")
        while (Bun.stringWidth(kept.join("")) > room() - 3) kept.shift()
        return kept.join("")
      }
      const DiffRow = (row: { line: Line; at: number }) => {
        const on = () => cursor() === row.at
        const tint = () => (row.line.kind === "add" ? theme.diffAdd : row.line.kind === "del" ? theme.diffDel : null)
        const text = () => row.line.text.replaceAll("\t", "  ")
        return (
          <>
            <box flexDirection="row" minHeight={1} backgroundColor={(on() && theme.selection) || tint() || undefined}>
              <text flexShrink={0} fg={on() ? theme.accent : theme.frame}>
                {`${on() ? "› " : "  "}${String(row.line.number).padStart(digits)} `}
              </text>
              <text flexShrink={0} fg={lineColor(row.line.kind)}>{`${SIGN[row.line.kind]} `}</text>
              <Show
                when={filetype}
                fallback={
                  <text fg={lineColor(row.line.kind)} flexGrow={1} wrapMode="char">
                    {text()}
                  </text>
                }
              >
                <code
                  content={text()}
                  filetype={filetype}
                  conceal={false}
                  syntaxStyle={syntaxStyle()}
                  fg={theme.text}
                  wrapMode="char"
                  flexGrow={1}
                />
              </Show>
            </box>
            <Show
              when={on() && draft() !== null}
              fallback={
                <For each={noteRows(row.line)}>
                  {(piece, index) => (
                    <text fg={theme.warning} wrapMode="none">
                      {`${" ".repeat(gutter)}${index() === 0 ? "└ " : "  "}${piece}`}
                    </text>
                  )}
                </For>
              }
            >
              <text wrapMode="none">
                <span style={{ fg: theme.accent }}>{`${" ".repeat(gutter)}└ `}</span>
                <span style={{ fg: theme.text }}>{typed()}</span>
                <span style={{ bg: theme.text }}> </span>
                <Show when={draft() === ""}>
                  <span style={{ fg: theme.muted }}>Note for the agent · enter keeps it, empty deletes</span>
                </Show>
              </text>
            </Show>
          </>
        )
      }
      return (
        <box flexDirection="column" width={props.width} height={props.height}>
          <Show when={rows.length > 0} fallback={<text fg={theme.muted}>{noHunks(diff)}</text>}>
            <box flexDirection="column" height={height()} overflow="hidden">
              <For each={visible()}>
                {(at) => {
                  const line = lineAt(at)
                  return line ? (
                    <DiffRow line={line} at={at} />
                  ) : (
                    <text fg={theme.frame}>{`${" ".repeat(gutter - 2)}⋮`}</text>
                  )
                }}
              </For>
            </box>
            <Show when={total() > 0}>
              <text fg={theme.muted}>{`${" ".repeat(gutter)}${plural(total())}`}</text>
            </Show>
          </Show>
        </box>
      )
    },
  })
  if (!dialog.shown) {
    mod.notify("Close the open dialog first", { level: "info" })
    return "refused"
  }
  await dialog.closed
  return send ? "send" : "closed"
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
    // Notes on diff lines, kept until they go to the prompt or YellowCode quits.
    const [notes, setNotes] = createSignal<Notes>({})
    // A note stays only while its line is in the file's diff as it was when the note was written.
    const refreshNotes = async () => {
      await refresh()
      const changed = changes()
      const current = await Promise.all(
        Object.keys(notes()).map(async (path) => {
          const change = changed.find((item) => item.path === path)
          return { path, rows: change ? diffLines(await fileDiff(cwd, change)) : [] }
        }),
      )
      for (const { path, rows } of current) setNotes((kept) => withoutStale(kept, path, rows))
    }
    const insertNotes = async () => {
      await refreshNotes()
      if (noteCount(notes()) === 0) return mod.notify("The lines of your notes have changed", { level: "info" })
      mod.prompt.insert(notesMessage(notes()))
      setNotes({})
    }
    const review = async (change: Change): Promise<boolean> => {
      const end = await showDiff(mod, cwd, change, { notes, setNotes })
      if (end === "send") await insertNotes()
      return end === "closed"
    }
    const open = (change: Change) =>
      void review(change).catch((error: unknown) => mod.log.warn("cannot show the diff", error))

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
      await refreshNotes()
      if (state() === null)
        return mod.notify(Bun.which("git") ? "Not a git repository" : "git is not installed", { level: "info" })
      const waiting = noteCount(notes())
      if (changes().length === 0 && waiting === 0) return mod.notify("No changes", { level: "info" })
      const files = changes().map((change) => ({
        id: change.path,
        label: `${change.letter} ${change.path}${notes()[change.path] ? ` · ${plural(notes()[change.path]?.length ?? 0)}` : ""}`,
        note: counts(change) || undefined,
      }))
      const id = await mod.dialogs.choose({
        title: "Changed files",
        // No path holds a NUL, so the id cannot be a file's.
        items: waiting > 0 ? [...files, { id: INSERT, label: `Insert ${plural(waiting)}` }] : files,
      })
      if (id === INSERT) return insertNotes()
      const change = changes().find((item) => item.path === id)
      if (change && (await review(change))) await pick()
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
