import type { PasteEvent, TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { argumentValues, findCommand, matchCommands, matchValues } from "../input/commands.ts"
import {
  type Draft,
  expandDraft,
  graphemes,
  type LoadImage,
  type ReadClipboard,
  toBufferOffset,
} from "../input/draft.ts"
import { historyStep } from "../input/history.ts"
import type { InputProvider } from "../input/provider.ts"
import type { OutgoingImage } from "../protocol/outgoing.ts"
import {
  argumentToken,
  atToken,
  commandLine,
  completeCommand,
  highlightRanges,
  replaceArgument,
  replaceToken,
  slashQuery,
} from "../input/token.ts"
import { syntaxStyle } from "../theme/theme.ts"
import { useChips } from "./chips.ts"
import { cut } from "./format.ts"
import { type Suggestion, suggestionRows } from "./suggestion-list.tsx"

export type Submission = { text: string; images: OutgoingImage[]; draft: Draft }

type Completion =
  | { kind: "command"; entries: Suggestion[] }
  | { kind: "argument"; entries: Suggestion[] }
  | { kind: "file"; start: number; entries: Suggestion[] }

export type CompletionOptions = {
  focused: Accessor<boolean>
  provider: Accessor<InputProvider>
  // The textarea's width, so the argument hint is cut to fit after the typed text.
  width: Accessor<number>
  // Rows free above the input for the list.
  room: Accessor<number>
  onSubmit: (submission: Submission) => void
  readClipboard: ReadClipboard
  loadImage: LoadImage
  history?: Accessor<Draft[]>
  onListOpen?: (open: boolean) => void
  // Called by ↓ on the last row without history, or on an empty prompt that is not browsing it.
  onLeaveDown?: () => void
  // Each new `seq` replaces the prompt with `text`.
  fill?: Accessor<{ text: string; seq: number } | undefined>
  // Called by Ctrl+C on an empty prompt; Ctrl+C on text clears it.
  onQuit?: () => void
}

// The `/` and `@` completion, the argument hint and the token highlight of a textarea.
// Without `history`, ↑↓ on a closed list are left to the textarea.
export function useCompletion(options: CompletionOptions) {
  let area: TextareaRenderable | undefined
  // Text put in by code (a restored draft, a history recall, a completed argument) is not an edit, so it opens no list.
  // Its content change arrives a microtask later, so it is recognised by its text: set `placed` before putting it in.
  let placed: string | null = null
  let browsing: number | null = null

  const [completion, setCompletion] = createSignal<Completion | null>(null)
  const [selected, setSelected] = createSignal(0)
  let fileRequest = 0

  const show = (next: Completion | null) => {
    setCompletion(next && next.entries.length > 0 ? next : null)
    setSelected(0)
  }

  const close = () => {
    fileRequest++
    setCompletion(null)
  }

  const shown = () => {
    const entries = completion()?.entries ?? []
    return entries.slice(0, suggestionRows(entries.length, options.room()))
  }
  const index = () => Math.max(0, Math.min(selected(), shown().length - 1))

  const [ghost, setGhost] = createSignal<{ text: string; hint: string } | null>(null)

  // The extmarks controller clears every highlight on each edit and on each mark change, after the content change
  // reaches us, so painting waits for a microtask.
  let painting = false
  const paint = () => {
    if (painting) return
    painting = true
    queueMicrotask(() => {
      painting = false
      if (!area || area.isDestroyed) return
      area.clearAllHighlights()
      const token = syntaxStyle().resolveStyleId("input-token")
      const chip = syntaxStyle().resolveStyleId("input-chip")
      const text = area.plainText
      const width = (end: number) => Bun.stringWidth(text.slice(0, end).replaceAll("\n", ""))
      const labels = chips.chips()
      if (chip !== null) {
        for (const range of labels) {
          area.addHighlightByCharRange({ start: width(range.start), end: width(range.end), styleId: chip })
        }
      }
      for (const range of highlightRanges(text, options.provider().commands())) {
        if (token === null || labels.some((other) => range.start < other.end && other.start < range.end)) continue
        area.addHighlightByCharRange({ start: width(range.start), end: width(range.end), styleId: token })
      }
    })
  }

  const chips = useChips({
    area: () => area,
    focused: options.focused,
    readClipboard: options.readClipboard,
    loadImage: options.loadImage,
    place: (text) => (placed = text),
    onChange: paint,
  })

  createEffect(() => {
    syntaxStyle()
    paint()
  })

  // The text the last refresh handled.
  let seen = ""

  const refresh = () => {
    if (!area) return
    const text = area.plainText
    if (text === seen) {
      paint()
      return
    }
    seen = text
    chips.sync()
    if (text !== ghost()?.text) setGhost(null)
    if (text === placed) return
    placed = null
    browsing = null
    const cursor = area.cursorOffset
    fileRequest++
    const query = slashQuery(text, cursor)
    if (query !== null) {
      const rows = matchCommands(options.provider().commands(), query)
      show({
        kind: "command",
        entries: rows.map(({ name, description, argumentHint }) => ({
          kind: "command",
          name,
          description,
          argumentHint,
        })),
      })
      return
    }
    const argument = argumentToken(text, cursor)
    const command = argument && findCommand(options.provider().commands(), argument.command)
    const values =
      argument && command ? matchValues(argumentValues(command, options.provider().models()), argument.query) : []
    if (values.length > 0) {
      show({ kind: "argument", entries: values.map(({ value, note }) => ({ kind: "value", value, note })) })
      return
    }
    const token = atToken(text, cursor)
    if (!token) {
      show(null)
      return
    }
    const request = fileRequest
    void options
      .provider()
      .files(token.query)
      .then((paths) => {
        if (request !== fileRequest) return
        show({ kind: "file", start: token.start, entries: paths.map((path) => ({ kind: "file", path })) })
      })
  }

  const leftToken = () => {
    if (!area) return
    // Undo and redo change the text without a content change event.
    if (area.plainText !== seen) queueMicrotask(refresh)
    if (ghost() && area.cursorOffset !== area.plainText.length) setGhost(null)
    const open = completion()
    if (!open) return
    const text = area.plainText
    const cursor = area.cursorOffset
    const inside =
      open.kind === "command"
        ? slashQuery(text, cursor) !== null
        : open.kind === "argument"
          ? argumentToken(text, cursor) !== null
          : atToken(text, cursor)?.start === open.start
    if (!inside) close()
  }

  createEffect(
    on(
      options.focused,
      (focused) => {
        if (!focused) close()
      },
      { defer: true },
    ),
  )

  createEffect(() => options.onListOpen?.(shown().length > 0))
  onCleanup(() => options.onListOpen?.(false))

  const submit = () => {
    if (!area) return
    const draft = chips.draft()
    options.onSubmit({ ...expandDraft(draft), draft })
    chips.clear()
  }

  // Only the changed middle is replaced, so the chips around it and the undo history stay.
  const edit = (next: { text: string; cursor: number }) => {
    if (!area) return
    const text = area.plainText
    const before = Array.from(graphemes.segment(text), ({ segment }) => segment)
    const after = Array.from(graphemes.segment(next.text), ({ segment }) => segment)
    let head = 0
    while (head < before.length && head < after.length && before[head] === after[head]) head++
    let tail = 0
    while (
      tail < before.length - head &&
      tail < after.length - head &&
      before[before.length - 1 - tail] === after[after.length - 1 - tail]
    )
      tail++
    const start = before.slice(0, head).join("").length
    const end = text.length - before.slice(before.length - tail).join("").length
    chips.replace(
      toBufferOffset(text, start),
      toBufferOffset(text, end),
      after.slice(head, after.length - tail).join(""),
    )
    area.cursorOffset = toBufferOffset(next.text, next.cursor)
  }

  const restore = (draft: Draft) => {
    if (!area || !draft.text) return
    placed = draft.text
    chips.load(draft)
    area.gotoBufferEnd()
  }

  // The memo drops reruns with the same seq, which the props around `fill` cause.
  const fillSeq = createMemo(() => options.fill?.()?.seq)
  createEffect(
    on(
      fillSeq,
      () => {
        const next = options.fill?.()
        if (next) restore({ text: next.text, chips: [] })
      },
      { defer: true },
    ),
  )

  const pick = (entry: Suggestion, enter: boolean) => {
    if (!area) return
    const text = area.plainText
    if (entry.kind === "command") {
      close()
      if (enter) {
        edit({ text: commandLine(text, entry.name), cursor: 0 })
        submit()
      } else {
        const next = completeCommand(text, entry.name)
        edit(next)
        const hint = entry.argumentHint.replace(/\s+/g, " ").trim()
        if (hint && next.text === `/${entry.name} `) setGhost({ text: next.text, hint })
      }
      return
    }
    if (entry.kind === "value") {
      close()
      const token = argumentToken(text, area.cursorOffset)
      if (!token) return
      const next = replaceArgument(text, token, entry.value)
      placed = next.text
      edit(next)
      if (enter) submit()
      return
    }
    const token = atToken(text, area.cursorOffset)
    if (token) edit(replaceToken(text, token, entry.path))
    else close()
  }

  const recall = (direction: "up" | "down"): boolean => {
    if (!area || !options.history) return false
    const step = historyStep(options.history(), browsing, direction, {
      row: area.visualCursor.visualRow + area.scrollY,
      rows: area.editorView.getTotalVirtualLineCount(),
      empty: area.plainText === "",
    })
    if (!step) return false
    const draft = step.entry ?? { text: "", chips: [] }
    browsing = step.state
    placed = draft.text
    chips.load(draft)
    area.cursorOffset = toBufferOffset(draft.text, step.cursor)
    close()
    return true
  }

  const onLastRow = () =>
    area !== undefined && area.visualCursor.visualRow + area.scrollY === area.editorView.getTotalVirtualLineCount() - 1
  const leavesDown = () => (options.history ? browsing === null && area?.plainText === "" : onLastRow())

  useKeyboard((key) => {
    if (!options.focused()) return
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      if (area && area.plainText !== "") {
        close()
        browsing = null
        edit({ text: "", cursor: 0 })
      } else options.onQuit?.()
      return
    }
    const rows = shown()
    const plain = !key.ctrl && !key.meta && !key.shift
    if (rows.length === 0) {
      if (plain && (key.name === "up" || key.name === "down") && recall(key.name)) key.preventDefault()
      else if (plain && key.name === "down" && options.onLeaveDown && leavesDown()) {
        key.preventDefault()
        options.onLeaveDown()
      }
      return
    }
    if (key.name === "escape") {
      key.preventDefault()
      close()
    } else if (plain && (key.name === "up" || key.name === "down")) {
      key.preventDefault()
      setSelected((index() + (key.name === "up" ? rows.length - 1 : 1)) % rows.length)
    } else if (key.name === "tab" || (plain && key.name === "return")) {
      key.preventDefault()
      const entry = rows[index()]
      if (entry) pick(entry, key.name === "return")
    }
  })

  // The hint's left edge in the textarea, and the hint cut to the room after the typed text.
  const hint = () => {
    const current = ghost()
    if (!current) return null
    const left = Bun.stringWidth(current.text)
    const room = options.width() - left
    return room > 0 ? { left, text: cut(current.hint, room) } : null
  }

  return {
    ref: (element: TextareaRenderable) => (area = element),
    chips: chips.chips,
    draft: chips.draft,
    paste: (event: PasteEvent) => chips.paste(event),
    shown,
    selected: index,
    hint,
    refresh,
    leftToken,
    submit,
    restore,
  }
}
