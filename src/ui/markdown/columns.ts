import { Lexer, type Tokens } from "marked"
import { is } from "./blocks.ts"
import { type Entry, groupDetails } from "./details.ts"

const parsed = new WeakMap<Tokens.Code, Entry[][] | null>()

export function columnsCode(entry: Entry) {
  const code = is(entry, "code")
  return code?.lang?.trim().toLowerCase() === "columns" ? code : undefined
}

// A block that is still streaming may have one column so far, or an empty one just started.
export function parseColumns(text: string, streaming = false): Entry[][] | null {
  const parts = text.split(/^---[ \t]*$/m)
  if (streaming && parts.length > 1 && !parts.at(-1)?.trim()) parts.pop()
  if (parts.length < (streaming ? 1 : 2) || parts.some((part) => !part.trim())) return null
  return parts.map((part) =>
    groupDetails(
      Lexer.lex(part.trim(), { gfm: true }).filter((token) => token.type !== "space" && token.type !== "def"),
    ),
  )
}

// One parse per token, so folds and refs inside the columns keep the same entries every time they are looked up.
export function columnsOf(entry: Entry): Entry[][] | null {
  const code = columnsCode(entry)
  if (!code) return null
  if (!parsed.has(code)) parsed.set(code, parseColumns(code.text))
  return parsed.get(code) ?? null
}
