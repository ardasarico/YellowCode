import { deflateSync } from "node:zlib"

export type Pixels = { data: Uint8Array; width: number; height: number }

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(Bun.hash.crc32(body))
  return Buffer.concat([head, body, crc])
}

// An 8-bit RGBA PNG of tightly packed rows, each with no filter.
export function encodePng({ data, width, height }: Pixels): Uint8Array {
  const row = width * 4
  const filtered = new Uint8Array((row + 1) * height)
  for (let y = 0; y < height; y++) filtered.set(data.subarray(y * row, (y + 1) * row), y * (row + 1) + 1)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(filtered)),
    chunk("IEND", new Uint8Array()),
  ])
}
