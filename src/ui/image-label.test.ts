import { expect, test } from "bun:test"
import { decodeImage } from "./image-label.tsx"

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(Bun.hash.crc32(body))
  return Buffer.concat([head, body, crc])
}

test("a picture with a valid header but broken pixels does not decode", () => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(64, 0)
  header.writeUInt32BE(48, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const signature = Buffer.from("\x89PNG\r\n\x1a\n", "latin1")
  const garbage = Buffer.from("not deflate data at all", "latin1")
  const png = Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", garbage), chunk("IEND", new Uint8Array())])
  expect(decodeImage(png)).toBeNull()
})
