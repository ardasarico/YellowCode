import { homedir } from "node:os"
import type { OutgoingImage } from "../protocol/outgoing.ts"
import type { ChatImage } from "../session/types.ts"

export type Chip = { kind: "text"; n: number; content: string } | { kind: "image"; n: number; image: OutgoingImage }
export type PlacedChip = { start: number; end: number; chip: Chip }
export type Draft = { text: string; chips: PlacedChip[] }

type ClipboardContent =
  | { kind: "image"; image: OutgoingImage }
  | { kind: "path"; path: string }
  | { kind: "text"; text: string }
  | null
export type ReadClipboard = () => Promise<ClipboardContent>
export type LoadImage = (path: string) => Promise<OutgoingImage | null>

const COLLAPSE_LENGTH = 800
const COLLAPSE_NEWLINES = 3

function newlines(text: string): number {
  return text.split("\n").length - 1
}

export function normalizePaste(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
}

export function collapses(text: string): boolean {
  return text.length > COLLAPSE_LENGTH || newlines(text) >= COLLAPSE_NEWLINES
}

export function chipLabel(chip: Chip): string {
  if (chip.kind === "image") return `[Image ${chip.n}]`
  const count = newlines(chip.content)
  if (count === 0) return `[Pasted text ${chip.n}]`
  return `[Pasted text ${chip.n} +${count} ${count === 1 ? "line" : "lines"}]`
}

export function imagePath(paste: string): string | null {
  const line = paste.replace(/\n$/, "")
  if (line.includes("\n")) return null
  let path = line.trim()
  const quote = path[0]
  if (path.length >= 2 && (quote === "'" || quote === '"') && path.endsWith(quote)) path = path.slice(1, -1)
  path = path.replaceAll(/\\(.)/g, "$1")
  if (path.startsWith("~/")) path = homedir() + path.slice(1)
  return path.startsWith("/") && /\.(png|jpe?g|gif|webp)$/i.test(path) ? path : null
}

export function expandDraft(draft: Draft): { text: string; images: OutgoingImage[] } {
  const images: OutgoingImage[] = []
  let text = ""
  let at = 0
  for (const { start, end, chip } of draft.chips.toSorted((a, b) => a.start - b.start)) {
    text += draft.text.slice(at, start)
    if (chip.kind === "text") {
      text += chip.content
    } else {
      images.push(chip.image)
      text += chipLabel({ ...chip, n: images.length })
    }
    at = end
  }
  return { text: text + draft.text.slice(at), images }
}

const MEDIA_TYPES: OutgoingImage["mediaType"][] = ["image/png", "image/jpeg", "image/gif", "image/webp"]

function mediaType(type: string): OutgoingImage["mediaType"] {
  return MEDIA_TYPES.find((known) => known === type) ?? "image/png"
}

export function draftFromMessage(text: string, images: ChatImage[]): Draft {
  const outgoing = images.map((image) => ({ mediaType: mediaType(image.mediaType), base64: image.data ?? "" }))
  const unlabeled = outgoing.flatMap((_, index) => (text.includes(`[Image ${index + 1}]`) ? [] : [index + 1]))
  const full = unlabeled.map((n) => `[Image ${n}] `).join("") + text
  const chips = outgoing.map((image, index): PlacedChip => {
    const label = `[Image ${index + 1}]`
    const start = full.indexOf(label)
    return { start, end: start + label.length, chip: { kind: "image", n: index + 1, image } }
  })
  return { text: full, chips: chips.toSorted((a, b) => a.start - b.start) }
}

export const graphemes = new Intl.Segmenter()

function width(grapheme: string): number {
  return grapheme === "\n" ? 1 : Bun.stringWidth(grapheme)
}

export function toBufferOffset(text: string, index: number): number {
  let offset = 0
  for (const { segment, index: at } of graphemes.segment(text)) {
    if (at >= index) break
    offset += width(segment)
  }
  return offset
}

export function toStringIndex(text: string, offset: number): number {
  let reached = 0
  for (const { segment, index } of graphemes.segment(text)) {
    if (reached >= offset) return index
    reached += width(segment)
  }
  return text.length
}
