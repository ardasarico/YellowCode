import { z } from "zod"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import type { ReadClipboard } from "./draft.ts"
import { fitImage } from "./image-file.ts"

// Finder puts the copied file's icon in the clipboard as TIFF, so file URLs must win over image data.
// Office and Pages put a rendered picture beside copied text, so text wins over image data,
// except a lone URL: Safari and Firefox "Copy Image" add the image's address as plain text.
const SCRIPT = `
ObjC.import("AppKit")
function read() {
  const pb = $.NSPasteboard.generalPasteboard
  const items = pb.pasteboardItems
  const files = []
  for (let i = 0; i < items.count; i++) {
    const url = items.objectAtIndex(i).stringForType("public.file-url")
    if (!url.isNil()) files.push($.NSURL.URLWithString(url).filePathURL.path.js)
  }
  if (files.length > 0) return { files }
  const string = pb.stringForType($.NSPasteboardTypeString)
  const text = string.isNil() ? "" : string.js
  const hasImage = !pb.availableTypeFromArray($([$.NSPasteboardTypePNG, $.NSPasteboardTypeTIFF])).isNil()
  if (text.length > 0 && !(hasImage && /^(https?|data|blob|file):\\S*$/i.test(text.trim()))) return { text }
  let png = pb.dataForType($.NSPasteboardTypePNG)
  if (png.isNil()) {
    const tiff = pb.dataForType($.NSPasteboardTypeTIFF)
    if (!tiff.isNil()) {
      png = $.NSBitmapImageRep.imageRepWithData(tiff).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $())
    }
  }
  if (!png.isNil()) return { png: png.base64EncodedStringWithOptions(0).js }
  if (text.length > 0) return { text }
  return null
}
JSON.stringify(read())
`

const Output = z.union([
  z.object({ files: z.array(z.string()) }),
  z.object({ png: z.string() }),
  z.object({ text: z.string() }),
  z.null(),
])

export const readClipboard: ReadClipboard = async () => {
  if (process.platform !== "darwin") return null
  const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", SCRIPT], { stdout: "pipe", stderr: "pipe" })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) {
    log.warn("clipboard read failed", { code, stderr: await new Response(proc.stderr).text() })
    return null
  }
  const json = parseJson(stdout)
  const output = json.ok ? Output.safeParse(json.value) : null
  if (!output?.success) {
    log.warn("clipboard read: unexpected output", stdout.slice(0, 200))
    return null
  }
  const content = output.data
  if (content === null) return null
  if ("files" in content) {
    const [file] = content.files
    if (content.files.length === 1 && file && /\.(png|jpe?g|gif|webp)$/i.test(file)) return { kind: "path", path: file }
    return { kind: "text", text: content.files.join(" ") }
  }
  if ("png" in content) {
    const image = await fitImage(Buffer.from(content.png, "base64"))
    return image && { kind: "image", image }
  }
  return { kind: "text", text: content.text }
}
