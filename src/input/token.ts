import { type Command, findCommand } from "./commands.ts"

export type AtToken = { start: number; end: number; query: string }

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

export function atToken(text: string, cursor: number): AtToken | null {
  let start = cursor
  while (start > 0 && !isSpace(text[start - 1])) start--
  if (text[start] !== "@" || start >= cursor) return null
  let end = cursor
  while (end < text.length && !isSpace(text[end])) end++
  return { start, end, query: text.slice(start + 1, cursor) }
}

export function replaceToken(text: string, token: AtToken, path: string): { text: string; cursor: number } {
  const folder = path.endsWith("/")
  const spaceFollows = isSpace(text[token.end])
  const insert = folder ? `@${path}` : spaceFollows ? `@${path}` : `@${path} `
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
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "@" || (start > 0 && !isSpace(text[start - 1]))) continue
    let end = start + 1
    while (end < text.length && !isSpace(text[end])) end++
    if (end > start + 1) ranges.push({ start, end })
    start = end
  }
  return ranges
}
