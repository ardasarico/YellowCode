import { expect, test } from "bun:test"
import { fitImage } from "./image-file.ts"
import { encodePng } from "./png.ts"

// Random pixels barely compress, so even a JPEG of them stays big.
function noisePng(width: number, height = width): Uint8Array {
  const data = new Uint8Array(width * height * 4)
  for (let at = 0; at < data.length; at += 65536) crypto.getRandomValues(data.subarray(at, at + 65536))
  for (let at = 3; at < data.length; at += 4) data[at] = 255
  return encodePng({ data, width, height })
}

test("a noisy image too big for one JPEG step still fits", () => {
  const image = fitImage(noisePng(2000))
  expect(image?.mediaType).toBe("image/jpeg")
  expect(Buffer.from(image?.base64 ?? "", "base64").length).toBeLessThanOrEqual(3.75 * 1024 * 1024)
})
