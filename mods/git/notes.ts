export type Line = { kind: "add" | "del" | "ctx"; number: number; text: string }
export type Row = Line | { kind: "gap" }
// `from` is the path a renamed file had, where its removed lines were.
export type Note = { line: Line; text: string; from?: string }
// By file path, in the order the files got their first note.
export type Notes = Record<string, Note[]>

// The lines of one file's `git diff`, with a gap row between hunks. An added or unchanged line carries its number in
// the new file, a removed one its number in the old file.
export function diffLines(diff: string): Row[] {
  const rows: Row[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false
      continue
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      if (rows.length > 0) rows.push({ kind: "gap" })
      oldLine = Number(header[1])
      newLine = Number(header[2])
      inHunk = true
    } else if (!inHunk || line.startsWith("\\")) continue
    else if (line.startsWith("+")) rows.push({ kind: "add", number: newLine++, text: line.slice(1) })
    else if (line.startsWith("-")) rows.push({ kind: "del", number: oldLine++, text: line.slice(1) })
    else {
      rows.push({ kind: "ctx", number: newLine++, text: line.slice(1) })
      oldLine++
    }
  }
  return rows
}

export const sameLine = (a: Line, b: Line) => a.kind === b.kind && a.number === b.number && a.text === b.text

export function noteAt(notes: Notes, path: string, line: Line): string {
  return notes[path]?.find((note) => sameLine(note.line, line))?.text ?? ""
}

// An empty text takes the line's note away.
export function withNote(notes: Notes, path: string, line: Line, text: string, from?: string | null): Notes {
  const rest = (notes[path] ?? []).filter((note) => !sameLine(note.line, line))
  const note: Note = { line, text: text.trim(), ...(from && { from }) }
  const next = note.text === "" ? rest : [...rest, note]
  const { [path]: _, ...others } = notes
  return next.length === 0 ? others : { ...notes, [path]: next }
}

// Drops the file's notes whose line is no longer in its diff as it was when the note was written.
export function withoutStale(notes: Notes, path: string, rows: readonly Row[]): Notes {
  const kept = (notes[path] ?? []).filter((note) => rows.some((row) => row.kind !== "gap" && sameLine(row, note.line)))
  const { [path]: _, ...others } = notes
  return kept.length === 0 ? others : { ...notes, [path]: kept }
}

export const noteCount = (notes: Notes) => Object.values(notes).reduce((sum, list) => sum + list.length, 0)

export function notesMessage(notes: Notes): string {
  const lines = Object.entries(notes).flatMap(([path, list]) =>
    list
      .toSorted((a, b) => a.line.number - b.line.number)
      .map((note) => {
        const removed = note.line.kind === "del"
        return `- ${(removed && note.from) || path}:${note.line.number}${removed ? " (removed line)" : ""} ${note.text}`
      }),
  )
  return `Notes on your changes:\n${lines.join("\n")}`
}

// Cuts a line into pieces no wider than `width` columns.
export function chunks(text: string, width: number): string[] {
  const pieces: string[] = []
  let piece = ""
  let used = 0
  for (const char of text) {
    const size = Bun.stringWidth(char)
    if (used + size > width && piece !== "") {
      pieces.push(piece)
      piece = ""
      used = 0
    }
    piece += char
    used += size
  }
  pieces.push(piece)
  return pieces
}
