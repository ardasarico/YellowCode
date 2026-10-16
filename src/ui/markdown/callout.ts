import { Lexer, type Token } from "marked"
import { type Entry, groupDetails } from "./details.ts"

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution"
export type Callout = { kind: CalloutKind; tokens: Entry[] }

const KINDS: CalloutKind[] = ["note", "tip", "important", "warning", "caution"]
const MARKER = /^\[!(\w+)\][ \t]*(?:\n|$)/

// Cached per token, so the code blocks inside keep their identity for fold numbering.
const cache = new WeakMap<Token, Callout | null>()

export function calloutOf(token: Token): Callout | null {
  if (token.type !== "blockquote") return null
  if (!cache.has(token)) {
    const match = MARKER.exec(String(token.text))
    const kind = KINDS.find((name) => name === match?.[1]?.toLowerCase())
    const body = String(token.text).slice(match?.[0].length ?? 0)
    cache.set(token, kind ? { kind, tokens: groupDetails(Lexer.lex(body, { gfm: true })) } : null)
  }
  return cache.get(token) ?? null
}
