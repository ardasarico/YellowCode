import { Lexer, type Token } from "marked"

export type Block = { key: string; token: Token }

export function isType<T extends Token["type"]>(
  token: { type: string },
  type: T,
): token is Extract<Token, { type: T }> {
  return token.type === type
}

export function is<T extends Token["type"]>(token: { type: string }, type: T): Extract<Token, { type: T }> | undefined {
  return isType(token, type) ? token : undefined
}

// While a block streams in, its last line may still be half written.
export function finishedText(text: string, streaming: boolean): string {
  return streaming ? text.slice(0, Math.max(0, text.lastIndexOf("\n"))) : text
}

const SKIPPED = new Set(["space", "def"])

// Reuses the previous Block object for every block whose source did not change,
// so a streaming message only re-renders its last block.
export function splitBlocks(markdown: string, previous: readonly Block[] = []): Block[] {
  const tokens = lex(markdown).filter((token) => !SKIPPED.has(token.type))
  return tokens.map((token, index) => {
    const key = `${index}:${token.type}`
    const old = previous[index]
    return old && old.key === key && old.token.raw === token.raw ? old : { key, token }
  })
}

// marked recurses once per nesting level, so thousands of nested quotes overflow the stack; that text is shown plain.
export function lex(markdown: string): Token[] {
  try {
    return Lexer.lex(markdown, { gfm: true })
  } catch {
    return [{ type: "text", raw: markdown, text: markdown }]
  }
}
