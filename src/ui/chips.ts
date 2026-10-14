import { decodePasteBytes, type PasteEvent, stripAnsiSequences, type TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { type Accessor, createSignal } from "solid-js"
import type { OutgoingImage } from "../protocol/outgoing.ts"
import {
  type Chip,
  chipLabel,
  collapses,
  type Draft,
  imagePath,
  type LoadImage,
  normalizePaste,
  type PlacedChip,
  type ReadClipboard,
  toBufferOffset,
  toStringIndex,
} from "../input/draft.ts"

export type ChipsOptions = {
  area: Accessor<TextareaRenderable | undefined>
  focused: Accessor<boolean>
  readClipboard: ReadClipboard
  loadImage: LoadImage
  // Called with the text an edit by code will leave, before the edit, so the edit opens no completion list.
  place: (text: string) => void
  // Called whenever the chips are read again, so they can be repainted.
  onChange: () => void
}

const typeId = (area: TextareaRenderable) => area.extmarks.registerType("paste-chip")

// A chip as the textarea holds it: an atomic extmark with buffer offsets.
type Mark = { id: number; start: number; end: number; chip: Chip }

// The `[Pasted text N …]` and `[Image N]` labels of a textarea. Each label is a virtual extmark carrying its chip;
// the extmarks controller keeps the marks in place through edits and undo, and the cursor jumps over them.
export function useChips(options: ChipsOptions) {
  const [chips, setChips] = createSignal<PlacedChip[]>([])
  let pathUndo: { id: number; text: string } | null = null
  // Undo brings back marks by id, so a chip stays here after its mark is gone, until `clear` drops the undo history.
  const chipOf = new Map<number, Chip>()

  const createMark = (area: TextareaRenderable, start: number, end: number, chip: Chip) => {
    const id = area.extmarks.create({ start, end, virtual: true, typeId: typeId(area) })
    chipOf.set(id, chip)
    return id
  }

  // A mark whose text is no longer its label (a selection cut into it) is dropped, and its text stays plain.
  const marks = (): Mark[] => {
    const area = options.area()
    if (!area) return []
    const type = typeId(area)
    const text = area.plainText
    const found: Mark[] = []
    for (const mark of area.extmarks.getAll()) {
      if (mark.typeId !== type) continue
      const chip = chipOf.get(mark.id)
      const label = text.slice(toStringIndex(text, mark.start), toStringIndex(text, mark.end))
      if (chip && label === chipLabel(chip)) found.push({ id: mark.id, start: mark.start, end: mark.end, chip })
      else area.extmarks.delete(mark.id)
    }
    return found.toSorted((a, b) => a.start - b.start)
  }

  const sync = () => {
    const text = options.area()?.plainText ?? ""
    setChips(
      marks().map(({ start, end, chip }) => ({
        start: toStringIndex(text, start),
        end: toStringIndex(text, end),
        chip,
      })),
    )
    options.onChange()
  }

  const draft = (): Draft => {
    sync()
    return { text: options.area()?.plainText ?? "", chips: chips() }
  }

  const load = (next: Draft) => {
    const area = options.area()
    if (!area) return
    area.replaceText(next.text)
    for (const { start, end, chip } of next.chips) {
      createMark(area, toBufferOffset(next.text, start), toBufferOffset(next.text, end), chip)
    }
    sync()
  }

  // Empties the textarea and its undo history, so no mark can come back.
  const clear = () => {
    options.area()?.setText("")
    chipOf.clear()
  }

  // Replaces the buffer range [start, end) with text, keeping the marks around it and the undo history.
  const replace = (start: number, end: number, text: string) => {
    const area = options.area()
    if (!area) return
    const from = area.editBuffer.offsetToPosition(start)
    const to = area.editBuffer.offsetToPosition(end)
    if (end > start && from && to) area.deleteRange(from.row, from.col, to.row, to.col)
    area.cursorOffset = start
    if (text) area.insertText(text)
  }

  const replacePlaced = (start: number, end: number, text: string) => {
    const plain = options.area()?.plainText ?? ""
    options.place(plain.slice(0, toStringIndex(plain, start)) + text + plain.slice(toStringIndex(plain, end)))
    replace(start, end, text)
  }

  const insert = (chip: Chip): number | null => {
    const area = options.area()
    if (!area) return null
    area.deleteSelection()
    const start = area.cursorOffset
    replacePlaced(start, start, chipLabel(chip))
    const id = createMark(area, start, area.cursorOffset, chip)
    sync()
    return id
  }

  const next = (kind: Chip["kind"]) =>
    Math.max(0, ...marks().flatMap(({ chip }) => (chip.kind === kind ? [chip.n] : []))) + 1

  const insertImage = (image: OutgoingImage) => insert({ kind: "image", n: next("image"), image })

  const pasteText = (text: string) => {
    if (collapses(text)) insert({ kind: "text", n: next("text"), content: text })
    else options.area()?.insertText(text)
  }

  // The cursor where an async paste started, put back when it lands if the text did not change meanwhile.
  const anchor = () => {
    const before = options.area()?.plainText
    const at = options.area()?.cursorOffset ?? 0
    return () => {
      const area = options.area()
      if (area && area.plainText === before) area.cursorOffset = at
    }
  }

  const attachPath = async (path: string, text: string) => {
    const back = anchor()
    const image = await options.loadImage(path)
    back()
    if (!image) {
      options.area()?.insertText(text)
      return
    }
    const id = insertImage(image)
    if (id !== null) pathUndo = { id, text }
  }

  const paste = (event: PasteEvent) => {
    const text = normalizePaste(stripAnsiSequences(decodePasteBytes(event.bytes)))
    const path = imagePath(text)
    if (path) {
      event.preventDefault()
      void attachPath(path, text)
    } else if (collapses(text)) {
      event.preventDefault()
      pasteText(text)
    }
  }

  const fromClipboard = async () => {
    const back = anchor()
    const content = await options.readClipboard()
    back()
    if (content?.kind === "image") insertImage(content.image)
    else if (content?.kind === "path") await attachPath(content.path, content.path)
    else if (content?.kind === "text") pasteText(normalizePaste(content.text))
  }

  useKeyboard((key) => {
    const area = options.area()
    if (!options.focused() || !area) return
    const undo = pathUndo
    pathUndo = null
    const plain = !key.ctrl && !key.meta && !key.shift && !key.super
    if (
      undo &&
      ((key.ctrl && (key.name === "_" || key.name === "-")) || (key.super && key.name === "z" && !key.shift))
    ) {
      const mark = marks().find(({ id }) => id === undo.id)
      if (mark) {
        key.preventDefault()
        replacePlaced(mark.start, mark.end, undo.text)
      }
    } else if ((key.ctrl || key.super) && key.name === "v" && !key.shift && !key.meta) {
      key.preventDefault()
      void fromClipboard()
    } else if (key.ctrl && key.name === "x" && !key.shift && !key.meta) {
      const cursor = area.cursorOffset
      const mark = marks().find(({ start, end, chip }) => chip.kind === "text" && start <= cursor && cursor <= end)
      if (mark?.chip.kind === "text") {
        key.preventDefault()
        replacePlaced(mark.start, mark.end, mark.chip.content)
      }
    } else if (plain && (key.name === "left" || key.name === "right") && !area.hasSelection()) {
      // The controller's own jump lands one cell beyond the label on both sides.
      const cursor = area.cursorOffset
      const mark = marks().find(({ start, end }) => (key.name === "left" ? end === cursor : start === cursor + 1))
      if (mark) {
        key.preventDefault()
        area.cursorOffset = mark.start
      }
    }
  })

  return { chips, sync, draft, load, clear, paste, replace }
}
