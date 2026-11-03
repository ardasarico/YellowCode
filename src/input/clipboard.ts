import { z } from "zod"
import { log } from "../log/log.ts"
import { parseJson } from "../json.ts"
import type { ReadClipboard } from "./draft.ts"
import { spawnLimited } from "../spawn.ts"
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
  if (process.platform !== "darwin") return readLinuxClipboard()
  const result = await spawnLimited(["osascript", "-l", "JavaScript", "-e", SCRIPT], { timeoutMs: 5000 })
  if (result === null) {
    log.warn("clipboard read timed out")
    return null
  }
  const { code, stdout, stderr } = result
  if (code !== 0) {
    log.warn("clipboard read failed", { code, stderr })
    return null
  }
  const json = parseJson(stdout)
  const output = json.ok ? Output.safeParse(json.value) : null
  if (!output?.success) {
    log.warn("clipboard read: unexpected output", { length: stdout.length })
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
    const image = fitImage(Buffer.from(content.png, "base64"))
    return image && { kind: "image", image }
  }
  return { kind: "text", text: content.text }
}

// Shown in place of the pasted content when no clipboard tool is installed.
export class ClipboardToolMissing extends Error {}

type Tool = { list: string[]; read: (type: string) => string[] }
const WL_PASTE: Tool = {
  list: ["wl-paste", "--list-types"],
  read: (type) => ["wl-paste", "--no-newline", "--type", type],
}
const XCLIP: Tool = {
  list: ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
  read: (type) => ["xclip", "-selection", "clipboard", "-t", type, "-o"],
}
const TEXT_TYPES = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "STRING"]
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]
let toldMissing = false

async function readOutput(command: string[]): Promise<Uint8Array | null> {
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 })
    const [bytes, code] = await Promise.all([new Response(child.stdout).bytes(), child.exited])
    return code === 0 ? bytes : null
  } catch (error) {
    log.warn("clipboard read failed", { command: command[0], error: String(error) })
    return null
  }
}

// Wayland first, then X11, which also reaches the Wayland clipboard through XWayland. Over SSH there is neither.
function linuxTool(): Tool | null {
  const wayland = Boolean(process.env["WAYLAND_DISPLAY"])
  const x11 = Boolean(process.env["DISPLAY"])
  if (wayland && Bun.which("wl-paste")) return WL_PASTE
  if (x11 && Bun.which("xclip")) return XCLIP
  if ((wayland || x11) && !toldMissing) {
    toldMissing = true
    throw new ClipboardToolMissing(`To paste images, install ${wayland ? "wl-clipboard" : "xclip"}`)
  }
  return null
}

// The same order as on macOS: copied files, then text unless it is the address beside a copied image, then the image.
async function readLinuxClipboard(): Promise<Awaited<ReturnType<ReadClipboard>>> {
  const tool = linuxTool()
  if (!tool) return null
  const listed = await readOutput(tool.list)
  const types = new Set(
    new TextDecoder()
      .decode(listed ?? new Uint8Array())
      .split("\n")
      .map((type) => type.trim()),
  )
  const text = async (type: string) => new TextDecoder().decode((await readOutput(tool.read(type))) ?? new Uint8Array())
  if (types.has("text/uri-list")) {
    const files = (await text("text/uri-list"))
      .split(/\r?\n/)
      .filter((line) => line.startsWith("file://"))
      .map((line) => decodeURIComponent(new URL(line).pathname))
    const [file] = files
    if (files.length === 1 && file && /\.(png|jpe?g|gif|webp)$/i.test(file)) return { kind: "path", path: file }
    if (files.length > 0) return { kind: "text", text: files.join(" ") }
  }
  const textType = TEXT_TYPES.find((type) => types.has(type))
  const pasted = textType ? await text(textType) : ""
  const imageType = IMAGE_TYPES.find((type) => types.has(type))
  if (pasted.length > 0 && !(imageType && /^(https?|data|blob|file):\S*$/i.test(pasted.trim())))
    return { kind: "text", text: pasted }
  const bytes = imageType ? await readOutput(tool.read(imageType)) : null
  const image = bytes && fitImage(bytes)
  if (image) return { kind: "image", image }
  return pasted.length > 0 ? { kind: "text", text: pasted } : null
}

// macOS has pbcopy; elsewhere the terminal takes the text through OSC 52.
export async function writeClipboard(text: string, osc52: (text: string) => boolean): Promise<boolean> {
  if (process.platform === "darwin") {
    const result = await spawnLimited(["pbcopy"], { timeoutMs: 2000, stdin: text })
    if (result?.code === 0) return true
    log.warn("pbcopy failed", result?.stderr ?? "timed out")
  }
  return osc52(text)
}
