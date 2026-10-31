// A bigger line means the agent is broken: its session is stopped before it fills the memory.
export const LINE_LIMIT = 256 * 1024 * 1024

export class LineTooLong extends Error {
  constructor() {
    super("a line from the agent is over 256 MB")
  }
}

export async function* splitLines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) yield line
      newline = buffer.indexOf("\n")
    }
    if (buffer.length > LINE_LIMIT) throw new LineTooLong()
  }

  const rest = (buffer + decoder.decode()).trim()
  if (rest) yield rest
}
