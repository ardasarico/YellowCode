import { expect, test } from "bun:test"
import { deflateSync } from "node:zlib"
import { fitImage } from "./image-file.ts"

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(Bun.hash.crc32(body))
  return Buffer.concat([head, body, crc])
}

// Random pixels barely compress, so even a JPEG of them stays big.
function noisePng(side: number): Uint8Array {
  const row = side * 3 + 1
  const pixels = new Uint8Array(row * side)
  for (let at = 0; at < pixels.length; at += 65536) crypto.getRandomValues(pixels.subarray(at, at + 65536))
  for (let y = 0; y < side; y++) pixels[y * row] = 0
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0)
  header.writeUInt32BE(side, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const signature = Buffer.from("\x89PNG\r\n\x1a\n", "latin1")
  const data = deflateSync(pixels, { level: 0 })
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", data), chunk("IEND", new Uint8Array())])
}

test.skipIf(process.platform !== "darwin")("a noisy image too big for one JPEG step still fits", async () => {
  const image = await fitImage(noisePng(2000))
  expect(image?.mediaType).toBe("image/jpeg")
  expect(Buffer.from(image?.base64 ?? "", "base64").length).toBeLessThanOrEqual(3.75 * 1024 * 1024)
})
