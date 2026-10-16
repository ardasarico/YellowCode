import { Lexer, type Token } from "marked"

export type Details = { type: "details"; raw: string; summary: string; lines: number; tokens: Entry[] }
export type Entry = Token | Details

export const isDetails = (entry: Entry): entry is Details => entry.type === "details"

const OPEN = /^<details[^>]*>\s*(?:<summary[^>]*>([\s\S]*?)<\/summary>)?/i
const CLOSE = /<\/details>\s*$/i

const isOpen = (token: Token) => token.type === "html" && OPEN.test(token.raw)
const isClose = (token: Token) => token.type === "html" && /^<\/details>/i.test(token.raw.trim())

const lexed = new WeakMap<Token, Token[]>()

function lex(token: Token, text: string): Token[] {
  if (!lexed.has(token)) lexed.set(token, Lexer.lex(text, { gfm: true }))
  return lexed.get(token) ?? []
}

function details(open: Token, body: Token[]): Details {
  const match = OPEN.exec(open.raw)
  const rest = open.raw.slice(match?.[0].length ?? 0)
  const tokens = rest.trim() ? [...lex(open, rest.replace(CLOSE, "")), ...body] : body
  const lines = tokens
    .map((token) => token.raw)
    .join("\n")
    .split("\n")
    .filter((line) => line.trim()).length
  return {
    type: "details",
    raw: [open, ...body].map((token) => token.raw).join("\n"),
    summary: match?.[1]?.replace(/<[^>]+>/g, "").trim() || "Details",
    lines,
    tokens: groupDetails(tokens),
  }
}

const nested = new WeakMap<readonly Token[], Entry[]>()

// The blocks of a quote or list item, kept so folds and refs find the same entries as the drawing.
export function nestedEntries(tokens: readonly Token[]): Entry[] {
  if (!nested.has(tokens)) nested.set(tokens, groupDetails(tokens))
  return nested.get(tokens) ?? []
}

// Turns each `<details>` … `</details>` run into one entry; an unclosed one stays as plain tokens.
export function groupDetails(tokens: readonly Token[]): Entry[] {
  const entries: Entry[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token) continue
    if (!isOpen(token)) {
      entries.push(token)
      continue
    }
    if (CLOSE.test(token.raw)) {
      entries.push(details(token, []))
      continue
    }
    let depth = 1
    let end = index + 1
    for (; end < tokens.length; end++) {
      const next = tokens[end]
      if (!next) continue
      if (isOpen(next) && !CLOSE.test(next.raw)) depth += 1
      else if (isClose(next)) depth -= 1
      if (depth === 0) break
    }
    if (depth > 0) {
      entries.push(token)
      continue
    }
    entries.push(details(token, tokens.slice(index + 1, end)))
    index = end
  }
  return entries
}
