import { expect, test } from "bun:test"
import { splitLines } from "./lines.ts"

function chunks(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  const iterator = parts[Symbol.iterator]()
  return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve(iterator.next()) }) }
}

test("keeps multi-byte characters split across chunks intact", async () => {
  const bytes = new TextEncoder().encode('{"a":"ş"}\r\n\n{"b":1}')
  const cut = bytes.indexOf(0xc5) + 1
  const lines = await Array.fromAsync(splitLines(chunks(bytes.slice(0, cut), bytes.slice(cut))))

  expect(lines).toEqual(['{"a":"ş"}', '{"b":1}'])
})
