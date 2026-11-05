import { render } from "grok-mermaid"
import type { Tokens } from "marked"
import { diffRows, type DiffRow, unifiedHunks } from "../diff.ts"
import { HEAD_LIMIT } from "../diff-view.tsx"
import { is, lex } from "./blocks.ts"
import { remember } from "./cache.ts"
import { calloutOf } from "./callout.ts"
import { hasData, parseChart } from "./chart.ts"
import { columnsOf } from "./columns.ts"
import { type Entry, groupDetails, isDetails, nestedEntries } from "./details.ts"
import { parseGantt } from "./gantt.ts"
import { rowCode } from "./row.ts"
import { parseStats, statsCode } from "./stats.ts"
import { LONG_TREE, parseTree, treeCode } from "./tree.ts"

export const LONG_CODE = 20
export const FOLDED_CODE = 10

export const foldId = (itemId: string, index: number) => `${itemId}/fold/${index}`

const rowsCache = new WeakMap<Tokens.Code, DiffRow[]>()

export function codeDiffRows(token: Tokens.Code): DiffRow[] {
  if (!rowsCache.has(token)) rowsCache.set(token, diffRows(unifiedHunks(token.text), Infinity))
  return rowsCache.get(token) ?? []
}

// A ```diff block that parses to at least one row.
export function diffOf(entry: Entry): Tokens.Code | undefined {
  const code = is(entry, "code")
  return code && /^diff\b/i.test(code.lang ?? "") && codeDiffRows(code).length > 0 ? code : undefined
}

export function mermaidOf(entry: Entry): Tokens.Code | undefined {
  const code = is(entry, "code")
  return code?.lang?.trim().toLowerCase() === "mermaid" ? code : undefined
}

const drawable = new Map<string, boolean>()

// A mermaid block that draws as a diagram or chart, whatever the width. Its fold shows the source.
export function drawsMermaid(text: string): boolean {
  return remember(drawable, 200, text, () => {
    const chart = parseChart(text)
    const gantt = parseGantt(text)
    if (chart) return hasData(chart)
    return gantt ? gantt.tasks.length > 0 : render(text) !== null
  })
}

function foldable(entry: Entry): boolean {
  if (isDetails(entry)) return true
  const mermaid = mermaidOf(entry)
  if (mermaid && drawsMermaid(mermaid.text)) return true
  const diff = diffOf(entry)
  if (diff) return codeDiffRows(diff).length > HEAD_LIMIT
  if (columnsOf(entry)) return false
  if (rowCode(entry)) return false
  const stats = statsCode(entry)
  if (stats && parseStats(stats.text)) return false
  const tree = treeCode(entry)
  const rows = tree && parseTree(tree.text)
  if (rows) return rows.length > LONG_TREE
  const code = is(entry, "code")
  return code !== undefined && code.text.split("\n").length > LONG_CODE
}

function children(entry: Entry): readonly Entry[] {
  if (isDetails(entry)) return entry.tokens
  const quote = is(entry, "blockquote")
  if (quote) return calloutOf(quote)?.tokens ?? nestedEntries(quote.tokens)
  const columns = columnsOf(entry)
  if (columns) return columns.flat()
  return is(entry, "list")?.items.flatMap((item) => nestedEntries(item.tokens)) ?? []
}

// Numbers folds in reading order. Folds inside a closed section still count, so numbers never shift.
function walkFolds(
  entries: readonly Entry[],
  isOpen: (index: number) => boolean,
  visit: (entry: Entry, index: number, hidden: boolean) => void,
): void {
  let count = 0
  const walk = (list: readonly Entry[], hidden: boolean) => {
    for (const entry of list) {
      let inner = hidden
      if (foldable(entry)) {
        const index = count++
        visit(entry, index, hidden)
        if (entry.type === "details" && !isOpen(index)) inner = true
      }
      walk(children(entry), inner)
    }
  }
  walk(entries, false)
}

export function foldNumbers(entries: readonly Entry[]): Map<Entry, number> {
  const numbers = new Map<Entry, number>()
  walkFolds(
    entries,
    () => true,
    (entry, index) => numbers.set(entry, index),
  )
  return numbers
}

const lexed = new Map<string, Entry[]>()

// A whole message's blocks, kept for keyboard selection, which looks at every message on each key.
export function messageEntries(markdown: string): Entry[] {
  return remember(lexed, 1000, markdown, () =>
    groupDetails(lex(markdown).filter((token) => token.type !== "space" && token.type !== "def")),
  )
}

// The folds a message shows, in order, for keyboard selection.
export function messageFolds(markdown: string, itemId: string, expanded: Record<string, boolean>): string[] {
  if (!/<details|(?:```|~~~)\s*mermaid/i.test(markdown) && markdown.split("\n").length <= LONG_CODE) return []
  const ids: string[] = []
  walkFolds(
    messageEntries(markdown),
    (index) => expanded[foldId(itemId, index)] === true,
    (_, index, hidden) => {
      if (!hidden) ids.push(foldId(itemId, index))
    },
  )
  return ids
}
