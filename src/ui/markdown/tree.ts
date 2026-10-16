import { is } from "./blocks.ts"
import type { Entry } from "./details.ts"

// Longer trees fold to their first rows; a project's top levels usually fit.
export const LONG_TREE = 30
export const FOLDED_TREE = 25

export type TreeRow = { prefix: string; name: string; folder: boolean; comment?: string }

type Node = { depth: number; name: string; comment?: string }

const DRAWN = /[├└│]/
const BRANCH = /^((?:│ {3}| {4})*)([├└]── ?)?(.*)$/
const SUMMARY = /^\d+ director(?:y|ies)(?:, \d+ files?)?$/
const COMMENT = /^(.+?)\s+#\s*(.*)$/

function nodeOf(line: string, drawn: boolean): Node | null {
  let depth: number
  let rest: string
  if (drawn) {
    const match = BRANCH.exec(line)
    const indent = match?.[1] ?? ""
    depth = indent.length / 4 + (match?.[2] ? 1 : 0)
    rest = match?.[3] ?? ""
  } else {
    const text = line.replace(/\t/g, "  ")
    const indent = /^ */.exec(text)?.[0].length ?? 0
    if (indent % 2) return null
    depth = indent / 2
    rest = text.slice(indent)
  }
  const comment = COMMENT.exec(rest.trim())
  const name = (comment?.[1] ?? rest).trim()
  if (!name) return null
  return { depth, name, ...(comment?.[2] ? { comment: comment[2] } : {}) }
}

// An indented list (2 spaces a level) or the output of `tree`.
export function parseTree(text: string): TreeRow[] | null {
  const lines = text
    .replace(/\u00a0/g, " ")
    .split("\n")
    .filter((line) => line.trim() && !SUMMARY.test(line.trim()))
  const drawn = lines.some((line) => DRAWN.test(line))
  const nodes: Node[] = []
  for (const line of lines) {
    const node = nodeOf(line, drawn)
    if (!node || node.depth > (nodes.at(-1)?.depth ?? -1) + 1) return null
    nodes.push(node)
  }
  if (!nodes.length) return null
  // A node is last unless a sibling follows it before a shallower node does.
  const isLast = nodes.map(() => true)
  const latest: number[] = []
  nodes.forEach((node, index) => {
    const sibling = latest[node.depth]
    if (sibling !== undefined) isLast[sibling] = false
    latest.length = node.depth
    latest[node.depth] = index
  })
  const open: boolean[] = []
  return nodes.map((node, index) => {
    const last = isLast[index] === true
    open.length = Math.max(0, node.depth - 1)
    const prefix = node.depth ? open.map((more) => (more ? "│  " : "   ")).join("") + (last ? "└─ " : "├─ ") : ""
    if (node.depth) open.push(!last)
    const row: TreeRow = {
      prefix,
      name: node.name,
      folder: node.name.endsWith("/") || (nodes[index + 1]?.depth ?? 0) > node.depth,
    }
    if (node.comment) row.comment = node.comment
    return row
  })
}

export function treeCode(entry: Entry) {
  const code = is(entry, "code")
  return code?.lang?.trim().toLowerCase() === "tree" ? code : undefined
}
