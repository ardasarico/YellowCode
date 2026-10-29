import { type Command, findCommand } from "./commands.ts"

// `quoted`: written @"…", the only form claude expands a path with spaces in; codex and opencode get the mention as plain
// text and leave the file to the model. `query` runs from after @ (or @") to the cursor.
export type AtToken = { start: number; end: number; query: string; quoted: boolean }

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char)
}

function firstTokenEnd(text: string): number {
  const space = text.search(/\s/)
  return space === -1 ? text.length : space
}

export function slashQuery(text: string, cursor: number): string | null {
  if (!text.startsWith("/") || cursor < 1) return null
  return cursor <= firstTokenEnd(text) ? text.slice(1, cursor) : null
}

export function completeCommand(text: string, name: string): { text: string; cursor: number } {
  const head = `/${name} `
  const rest = text.slice(firstTokenEnd(text))
  return { text: head + (rest.startsWith(" ") ? rest.slice(1) : rest), cursor: head.length }
}

export function commandLine(text: string, name: string): string {
  return `/${name}${text.slice(firstTokenEnd(text))}`
}

export type ArgumentToken = { command: string; start: number; end: number; query: string }

export function argumentToken(text: string, cursor: number): ArgumentToken | null {
  const nameEnd = firstTokenEnd(text)
  if (!text.startsWith("/") || text[nameEnd] !== " ") return null
  const start = nameEnd + 1
  let end = start
  while (end < text.length && !isSpace(text[end])) end++
  if (cursor < start || cursor > end) return null
  return { command: text.slice(1, nameEnd), start, end, query: text.slice(start, cursor) }
}

export function replaceArgument(text: string, token: ArgumentToken, value: string): { text: string; cursor: number } {
  return { text: text.slice(0, token.start) + value + text.slice(token.end), cursor: token.start + value.length }
}

type Mention = { start: number; end: number; quoted: boolean; closed: boolean }

// The @ mentions of a text, each starting at a word start. A quoted one runs to its closing quote; one still unclosed
// (being typed) runs to the first whitespace at or after `cursor`; a plain one to the next whitespace.
function mentions(text: string, cursor: number): Mention[] {
  const found: Mention[] = []
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "@" || (start > 0 && !isSpace(text[start - 1]))) continue
    const quoted = text[start + 1] === '"'
    const close = quoted ? text.indexOf('"', start + 2) : -1
    let end = close + 1
    if (close === -1) {
      end = quoted ? Math.max(cursor, start + 2) : start + 1
      while (end < text.length && !isSpace(text[end])) end++
    }
    found.push({ start, end, quoted, closed: close !== -1 })
    start = end
  }
  return found
}

export function atToken(text: string, cursor: number): AtToken | null {
  for (const { start, end, quoted, closed } of mentions(text, cursor)) {
    const from = start + (quoted ? 2 : 1)
    // A closed quote ends the mention; the cursor after it is outside.
    if (cursor < from || cursor > (closed ? end - 1 : end)) continue
    return { start, end, quoted, query: text.slice(from, cursor) }
  }
  return null
}

// A space typed after the "/" of an open @"folder/ ends the mention, so its quote closes there; claude expands only
// a closed one. A path segment never starts with a space, so going on inside the folder is not affected.
export function closeFolderQuote(text: string, cursor: number): { text: string; cursor: number } | null {
  for (const { start, end, quoted, closed } of mentions(text, cursor)) {
    if (!quoted || closed) continue
    const slash = text.indexOf("/ ", start + 2)
    if (slash === -1 || slash >= end) continue
    const at = slash + 1
    return { text: `${text.slice(0, at)}"${text.slice(at)}`, cursor: cursor > slash ? cursor + 1 : cursor }
  }
  return null
}

// A path with whitespace goes in as @"path" (and a folder stays open inside the quote, so the list goes on); one with a
// quote in it goes in plain.
export function replaceToken(text: string, token: AtToken, path: string): { text: string; cursor: number } {
  const folder = path.endsWith("/")
  const quote = /\s/.test(path) && !path.includes('"')
  const mention = quote ? `@"${path}${folder ? "" : '"'}` : `@${path}`
  const spaceFollows = isSpace(text[token.end])
  const insert = folder || spaceFollows ? mention : `${mention} `
  const cursor = token.start + insert.length + (!folder && spaceFollows ? 1 : 0)
  return { text: `${text.slice(0, token.start)}${insert}${text.slice(token.end)}`, cursor }
}

export type Range = { start: number; end: number }

export function highlightRanges(text: string, commands: Command[]): Range[] {
  const ranges: Range[] = []
  const nameEnd = firstTokenEnd(text)
  if (text.startsWith("/") && nameEnd > 1 && findCommand(commands, text.slice(1, nameEnd))) {
    ranges.push({ start: 0, end: nameEnd })
  }
  for (const { start, end, quoted } of mentions(text, text.length)) {
    if (end > start + (quoted ? 2 : 1)) ranges.push({ start, end })
  }
  return ranges
}
