import type { PasteEvent, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { argumentValues, findCommand, matchCommands, matchValues } from "../input/commands.ts"
import {
  type Draft,
  expandDraft,
  graphemes,
  type LoadImage,
  type ReadClipboard,
  stringIndexes,
  toBufferOffset,
} from "../input/draft.ts"
import { historyStep } from "../input/history.ts"
import type { InputProvider } from "../input/provider.ts"
import { log } from "../log/log.ts"
import type { PromptImage } from "../agent/agent.ts"
import {
  argumentToken,
  atToken,
  closeFolderQuote,
  commandLine,
  completeCommand,
  highlightRanges,
  replaceArgument,
  replaceToken,
  slashQuery,
} from "../input/token.ts"
import { syntaxStyle } from "../theme/theme.ts"
import { measureIn, useChips } from "./chips.ts"
import { cut } from "./format.ts"
import { type Suggestion, suggestionRows } from "./suggestion-list.tsx"

export type Submission = { text: string; images: PromptImage[]; draft: Draft }

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
  // False keeps the text in the prompt.
  onSubmit: (submission: Submission) => boolean
  readClipboard: ReadClipboard
  loadImage: LoadImage
  history?: Accessor<Draft[]>
  onListOpen?: (open: boolean) => void
  // Called by ↓ on an empty prompt that is not browsing the history.
  onLeaveDown?: () => void
  // Each new `seq` replaces the prompt with `draft`. A `/` typed right after it starts a command in its place.
  // `insert` puts the draft's text at the cursor instead of replacing what is there.
  fill?: Accessor<{ draft: Draft; seq: number; ifEmpty?: boolean; insert?: boolean } | undefined>
  // Called by Ctrl+C on an empty prompt; Ctrl+C on text clears it.
  onQuit?: () => void
  // Called by Esc on an empty prompt with no list open.
  onEscape?: () => void
  // Called by Backspace on an empty prompt; true when it took the key.
  onBackspaceEmpty?: () => boolean
  // Called when `!` is typed into an empty prompt; true takes the `!` away.
  onBang?: () => boolean
  // Called when ↑ or ↓ puts back a message written to an agent.
  onRecall?: (to: NonNullable<Draft["to"]> | null) => void
}

const cursorIndex = (area: TextareaRenderable) => stringIndexes(area.plainText, measureIn(area))(area.cursorOffset)

// The `/` and `@` completion, the argument hint and the token highlight of a textarea.
// Without `history`, ↑↓ on a closed list are left to the textarea.
export function useCompletion(options: CompletionOptions) {
  let area: TextareaRenderable | undefined
  // Text put in by code (a restored draft, a history recall, a completed argument) is not an edit, so it opens no list.
  // Its content change arrives a microtask later, so it is recognised by its text: set `placed` before putting it in.
  let placed: string | null = null
  const [browsing, setBrowsing] = createSignal<{ state: number; total: number } | null>(null)
  const [hiddenAbove, setHiddenAbove] = createSignal(0)
  const [unfoldable, setUnfoldable] = createSignal(false)
  // The textarea scrolls to its cursor while it is drawn, and an edit by code moves the cursor halfway through,
  // so both are read after the next frame.
  const renderer = useRenderer()
  let sampling = false
  const sampleCursor = () => {
    if (sampling) return
    sampling = true
    const sample = () => {
      renderer.removePostProcessFn(sample)
      sampling = false
      const live = area && !area.isDestroyed ? area : undefined
      setHiddenAbove(live?.scrollY ?? 0)
      setUnfoldable(live !== undefined && chips.foldedAtCursor() !== undefined)
    }
    renderer.addPostProcessFn(sample)
    renderer.requestRender()
  }
  // The text of the last fill while it is still untouched.
  let filled: string | null = null

  const [completion, setCompletion] = createSignal<Completion | null>(null)
  const [selected, setSelected] = createSignal(0)
  let fileRequest = 0

  // The first entry the list shows; the rows shown follow the selection through a longer list.
  const [top, setTop] = createSignal(0)

  const show = (next: Completion | null) => {
    setCompletion(next && next.entries.length > 0 ? next : null)
    setSelected(0)
    setTop(0)
  }

  const close = () => {
    fileRequest++
    setCompletion(null)
  }

  const entries = () => completion()?.entries ?? []
  const rowCount = () => suggestionRows(entries().length, options.room())
  const index = () => Math.max(0, Math.min(selected(), entries().length - 1))
  const first = () => Math.max(0, Math.min(top(), index(), entries().length - rowCount()), index() - rowCount() + 1)
  const shown = () => (rowCount() === 0 ? [] : entries().slice(first(), first() + rowCount()))
  const select = (next: number) => {
    setSelected(next)
    setTop(first())
  }

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
      const measure = measureIn(area)
      const width = (end: number) => measure(text.slice(0, end).replaceAll("\n", ""))
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
    sampleCursor()
    const text = area.plainText
    if (text === seen) {
      paint()
      return
    }
    // Only typing and pasting add text; an undo that brings a "/ " back must not have its quote closed again.
    const grew = text.length > seen.length
    seen = text
    if (grew && text === "!" && options.onBang?.()) {
      edit({ text: "", cursor: 0 })
      return
    }
    chips.sync()
    if (text !== ghost()?.text) setGhost(null)
    if (text === placed) return
    placed = null
    setBrowsing(null)
    const slash = filled !== null && text === `${filled}/`
    filled = null
    if (slash) {
      edit({ text: "/", cursor: 1 })
      return
    }
    const cursor = cursorIndex(area)
    const closed = grew ? closeFolderQuote(text, cursor) : null
    if (closed) {
      edit(closed)
      return
    }
    fileRequest++
    const query = slashQuery(text, cursor)
    if (query !== null) {
      const rows = matchCommands(options.provider().commands(), query)
      show({
        kind: "command",
        entries: rows.map(({ name, description, argumentHint, match, alias }) => ({
          kind: "command",
          name,
          description,
          argumentHint,
          match,
          alias,
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
      .catch((error: unknown) => log.warn("file suggestions failed", String(error)))
  }

  const leftToken = () => {
    if (!area) return
    sampleCursor()
    // Undo and redo change the text without a content change event.
    if (area.plainText !== seen) queueMicrotask(refresh)
    if (ghost() && cursorIndex(area) !== area.plainText.length) setGhost(null)
    const open = completion()
    if (!open) return
    const text = area.plainText
    const cursor = cursorIndex(area)
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
    if (options.onSubmit({ ...expandDraft(draft), draft })) chips.clear()
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
    const measure = measureIn(area)
    chips.replace(
      toBufferOffset(text, start, measure),
      toBufferOffset(text, end, measure),
      after.slice(head, after.length - tail).join(""),
    )
    area.cursorOffset = toBufferOffset(next.text, next.cursor, measure)
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
        if (!next || (next.ifEmpty && area && area.plainText !== "")) return
        if (next.insert) {
          area?.insertText(next.draft.text)
          return
        }
        restore(next.draft)
        filled = next.draft.text || null
      },
      { defer: true },
    ),
  )

  const pick = (entry: Suggestion, enter: boolean) => {
    if (!area) return
    const text = area.plainText
    if (entry.kind === "command") {
      close()
      const name = entry.alias ?? entry.name
      if (enter) {
        edit({ text: commandLine(text, name), cursor: 0 })
        submit()
      } else {
        const next = completeCommand(text, name)
        edit(next)
        const hint = entry.argumentHint.replace(/\s+/g, " ").trim()
        if (hint && next.text === `/${name} `) setGhost({ text: next.text, hint })
      }
      return
    }
    if (entry.kind === "value") {
      close()
      const token = argumentToken(text, cursorIndex(area))
      if (!token) return
      const next = replaceArgument(text, token, entry.value)
      placed = next.text
      edit(next)
      if (enter) submit()
      return
    }
    const token = atToken(text, cursorIndex(area))
    if (token) edit(replaceToken(text, token, entry.path))
    else close()
  }

  const recall = (direction: "up" | "down"): boolean => {
    if (!area || !options.history) return false
    const step = historyStep(options.history(), browsing()?.state ?? null, direction, {
      row: area.visualCursor.visualRow + area.scrollY,
      rows: area.editorView.getTotalVirtualLineCount(),
      empty: area.plainText === "",
    })
    if (!step) return false
    const draft = step.entry ?? { text: "", chips: [] }
    setBrowsing(step.state === null ? null : { state: step.state, total: step.total })
    placed = draft.text
    chips.load(draft)
    area.cursorOffset = toBufferOffset(draft.text, step.cursor, measureIn(area))
    close()
    options.onRecall?.(draft.to ?? null)
    return true
  }

  const leavesDown = () => browsing() === null && area?.plainText === ""

  useKeyboard((key) => {
    if (!options.focused()) return
    // ↑ in the textarea moves the cursor without a cursor change event.
    sampleCursor()
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      if (area && area.plainText !== "") {
        close()
        setBrowsing(null)
        edit({ text: "", cursor: 0 })
      } else options.onQuit?.()
      return
    }
    const rows = shown()
    const plain = !key.ctrl && !key.meta && !key.shift
    if (rows.length === 0) {
      if (plain && key.name === "escape" && area?.plainText === "") {
        key.preventDefault()
        options.onEscape?.()
      } else if (plain && key.name === "backspace" && area?.plainText === "" && options.onBackspaceEmpty?.()) {
        key.preventDefault()
      } else if (plain && (key.name === "up" || key.name === "down") && recall(key.name)) key.preventDefault()
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
      const count = entries().length
      select((index() + (key.name === "up" ? count - 1 : 1)) % count)
    } else if (key.name === "tab" || (plain && key.name === "return")) {
      key.preventDefault()
      const entry = entries()[index()]
      // A typed name the row only matches inside, like /plan on /prova:planning, may be a command the list does
      // not show; Enter sends it as typed rather than running another command.
      if (entry?.kind === "command" && key.name === "return" && entry.match.start > 0) {
        close()
        submit()
      } else if (entry) pick(entry, key.name === "return")
    }
  })

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
    selected: () => index() - first(),
    hint,
    historyPosition: () => {
      const current = browsing()
      return current ? { n: current.state + 1, m: current.total } : null
    },
    hiddenAbove,
    sampleCursor,
    unfoldable,
    refresh,
    leftToken,
    submit,
    restore,
  }
}
