// Rows of a csv or tsv text: fields may be quoted, with "" for a quote and line breaks inside quotes. Null when a quote
// is left open.
export function parseRows(text: string, separator: string): string[][] | null {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index++
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"' && field === "") quoted = true
    else if (char === separator) {
      row.push(field)
      field = ""
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""))
      rows.push(row)
      row = []
      field = ""
    } else field += char
  }
  if (quoted) return null
  if (field !== "" || row.length > 0) rows.push([...row, field.replace(/\r$/, "")])
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""))
}
