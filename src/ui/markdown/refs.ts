import { closeSync, openSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import type { Token } from "marked"
import { is } from "./blocks.ts"
import { calloutOf } from "./callout.ts"
import { columnsOf } from "./columns.ts"
import { remember } from "./cache.ts"
import { type Entry, isDetails, nestedEntries } from "./details.ts"
import { foldId, foldNumbers, messageEntries } from "./folds.ts"

export type FileRef = { path: string; line?: number; end?: number }
export type RefTarget = { kind: "file"; ref: FileRef } | { kind: "image"; n: number }
export type Part = { text: string; target?: RefTarget }

const MAX_BYTES = 1024 * 1024
const SNIFF = 8192

export const refId = (itemId: string, index: number) => `${itemId}/ref/${index}`

export function refTarget(id: string): { itemId: string; index: number } | null {
  const match = /^(.+)\/ref\/(\d+)$/.exec(id)
  return match ? { itemId: match[1] ?? "", index: Number(match[2]) } : null
}

const readable = new Map<string, boolean>()

// An image, or a text file small enough to preview: not a folder, not binary.
function isTarget(path: string): boolean {
  return remember(readable, 5000, path, () => {
    try {
      const stat = statSync(path, { throwIfNoEntry: false })
      if (!stat?.isFile()) return false
      if (isImagePath(path)) return true
      if (stat.size > MAX_BYTES) return false
      const fd = openSync(path, "r")
      const head = new Uint8Array(Math.min(SNIFF, stat.size))
      readSync(fd, head, 0, head.length, 0)
      closeSync(fd)
      return !head.includes(0)
    } catch {
      return false
    }
  })
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i
const POSITION = /^(.+?)(?::(\d+)(?:-(\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)?$/

export const isImagePath = (path: string) => IMAGE.test(path)

export function parseRef(text: string, cwd: string): FileRef | null {
  const match = POSITION.exec(text)
  const raw = match?.[1]
  if (!raw || !/\/|\.[a-z0-9]+$/i.test(raw) || /^[a-z][a-z\d+.-]*:/i.test(raw)) return null
  const path = raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : resolve(cwd, raw)
  if (!isTarget(path)) return null
  const line = Number(match?.[2] ?? match?.[4]) || undefined
  const end = Number(match?.[3] ?? match?.[5]) || undefined
  return { path, ...(line ? { line } : {}), ...(line && end && end > line ? { end } : {}) }
}

const WORD = /(\S+)/
const MENTION = /\[Image (\d+)\]/g

function wordParts(text: string, cwd: string): Part[] {
  const parts: Part[] = []
  text.split(WORD).forEach((piece, index) => {
    const match = index % 2 === 1 ? /^([("'`]*)(.*?)([.,;:!?)"'`]*)$/.exec(piece) : null
    const ref = match?.[2] ? parseRef(match[2], cwd) : null
    if (!ref || !match) {
      if (piece) parts.push({ text: piece })
      return
    }
    if (match[1]) parts.push({ text: match[1] })
    parts.push({ text: match[2] ?? "", target: { kind: "file", ref } })
    if (match[3]) parts.push({ text: match[3] })
  })
  return parts
}

// Plain text split into file references, `[Image N]` mentions and the text between them.
export function textParts(text: string, cwd: string): Part[] {
  const parts: Part[] = []
  let at = 0
  for (const match of text.matchAll(MENTION)) {
    if (Number(match[1]) === 0) continue
    parts.push(...wordParts(text.slice(at, match.index), cwd))
    parts.push({ text: match[0], target: { kind: "image", n: Number(match[1]) } })
    at = match.index + match[0].length
  }
  parts.push(...wordParts(text.slice(at), cwd))
  return parts
}

function findTargets(token: Token, cwd: string): RefTarget[] {
  if (token.type === "codespan") {
    const ref = parseRef(String(token.text).trim(), cwd)
    return ref ? [{ kind: "file", ref }] : []
  }
  if (token.type === "link") {
    const ref = parseRef(String(token.href), cwd)
    return ref ? [{ kind: "file", ref }] : []
  }
  if (token.type === "text" && !("tokens" in token && token.tokens)) {
    return textParts(String(token.text), cwd).flatMap((part) => (part.target ? [part.target] : []))
  }
  return []
}

const targets = new WeakMap<Token, { cwd: string; targets: RefTarget[] }>()

// Found once per token, as keyboard selection and streaming look at a whole message again each time.
export function tokenTargets(token: Token, cwd: string): RefTarget[] {
  const found = targets.get(token)
  if (found?.cwd === cwd) return found.targets
  const made = findTargets(token, cwd)
  targets.set(token, { cwd, targets: made })
  return made
}

type Found = { token: Token; target: RefTarget; hidden: boolean }

function inlineChildren(token: Token): readonly Token[] {
  if (token.type === "link" || token.type === "codespan") return []
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : []
}

// Every reference in reading order, matching the order the chat draws them in, columns left to right. Tables and
// code stay plain.
function collect(entries: readonly Entry[], cwd: string, closed: (entry: Entry) => boolean): Found[] {
  const found: Found[] = []
  const inline = (tokens: readonly Token[], hidden: boolean) => {
    for (const token of tokens) {
      for (const target of tokenTargets(token, cwd)) found.push({ token, target, hidden })
      inline(inlineChildren(token), hidden)
    }
  }
  const blocks = (list: readonly Entry[], hidden: boolean) => {
    for (const entry of list) {
      if (isDetails(entry)) {
        blocks(entry.tokens, hidden || closed(entry))
        continue
      }
      const quote = is(entry, "blockquote")
      const columns = columnsOf(entry)
      if (quote) blocks(calloutOf(quote)?.tokens ?? nestedEntries(quote.tokens), hidden)
      else if (columns) for (const column of columns) blocks(column, hidden)
      else if (entry.type === "list")
        blocks(is(entry, "list")?.items.flatMap((item) => nestedEntries(item.tokens)) ?? [], hidden)
      else if (entry.type === "heading" || entry.type === "paragraph" || entry.type === "text")
        inline("tokens" in entry && entry.tokens ? entry.tokens : [entry], hidden)
    }
  }
  blocks(entries, false)
  return found
}

// The index of each token's first reference, for numbering refs while drawing.
export function refNumbers(entries: readonly Entry[], cwd: string): Map<Token, number> {
  const numbers = new Map<Token, number>()
  collect(entries, cwd, () => false).forEach(({ token }, index) => {
    if (!numbers.has(token)) numbers.set(token, index)
  })
  return numbers
}

export function messageTargets(markdown: string, cwd: string): RefTarget[] {
  return collect(messageEntries(markdown), cwd, () => false).map(({ target }) => target)
}

// The references a message shows, in order, for keyboard selection.
export function messageRefs(
  markdown: string,
  itemId: string,
  cwd: string,
  expanded: Record<string, boolean>,
): string[] {
  const entries = messageEntries(markdown)
  const folds = foldNumbers(entries)
  const closed = (entry: Entry) => expanded[foldId(itemId, folds.get(entry) ?? -1)] !== true
  return collect(entries, cwd, closed).flatMap(({ hidden }, index) => (hidden ? [] : [refId(itemId, index)]))
}
