/* oxlint-disable no-await-in-loop */
const NEWLINE = 0x0a
const decoder = new TextDecoder()

export type BackwardLine = { line: string; offset: number }

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (b.length === 0) return a
  const bytes = new Uint8Array(a.length + b.length)
  bytes.set(a)
  bytes.set(b, a.length)
  return bytes
}

export async function* readLinesBackward(
  path: string,
  end: number,
  chunkSize = 1024 * 1024,
): AsyncGenerator<BackwardLine> {
  const file = Bun.file(path)
  let carry = new Uint8Array(0)
  let start = end
  while (start > 0) {
    const from = Math.max(0, start - chunkSize)
    const bytes = join(await file.slice(from, start).bytes(), carry)
    let lineEnd = bytes.length
    let newline = lineEnd > 0 ? bytes.lastIndexOf(NEWLINE, lineEnd - 1) : -1
    while (newline !== -1) {
      if (newline + 1 < lineEnd) {
        yield { line: decoder.decode(bytes.subarray(newline + 1, lineEnd)), offset: from + newline + 1 }
      }
      lineEnd = newline
      newline = newline > 0 ? bytes.lastIndexOf(NEWLINE, newline - 1) : -1
    }
    carry = bytes.slice(0, lineEnd)
    start = from
  }
  if (carry.length > 0) yield { line: decoder.decode(carry), offset: 0 }
}
