import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, extname, resolve } from "node:path"
import { marked, type Token } from "marked"
import type { ChatImage } from "../../session/types.ts"
import { lex } from "./blocks.ts"

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

const MAX_BYTES = 20 * 1024 * 1024

export type ImageProblem = "not found" | "too large" | "not a file"

export function localImageProblem(path: string): ImageProblem | null {
  const stat = statSync(path, { throwIfNoEntry: false })
  if (!stat) return "not found"
  if (!stat.isFile()) return "not a file"
  return stat.size > MAX_BYTES ? "too large" : null
}

// Only a regular file of a sane size: /dev/zero or a FIFO would be read forever.
export function readLocalImage(path: string): Buffer | null {
  return localImageProblem(path) === null ? readFileSync(path) : null
}

function decoded(href: string): string {
  try {
    return decodeURI(href)
  } catch {
    return href
  }
}

export function isLocalImage(href: string): boolean {
  return !/^[a-z][a-z\d+.-]*:/i.test(href)
}

function localImage(token: Token, cwd: string): ChatImage | null {
  if (token.type !== "image" || !isLocalImage(String(token.href))) return null
  const href = String(token.href)
  const at = (written: string) =>
    written.startsWith("~/") ? resolve(homedir(), written.slice(2)) : resolve(cwd, written)
  // A link's path may be percent-encoded, as Markdown links with spaces or other scripts often are.
  const path = existsSync(at(href)) ? at(href) : at(decoded(href))
  return { name: basename(path), mediaType: MEDIA_TYPES[extname(path).toLowerCase()] ?? "", data: null, path }
}

export function tokenImages(tokens: Token[], cwd: string): ChatImage[] {
  const images: ChatImage[] = []
  void marked.walkTokens(tokens, (token) => {
    const image = localImage(token, cwd)
    if (image) images.push(image)
  })
  return images
}

// A block's local images, grouped by the source line they are written on.
export function imageLines(block: Token, cwd: string): ChatImage[][] {
  const lines: ChatImage[][] = []
  let from = 0
  void marked.walkTokens([block], (token) => {
    const image = localImage(token, cwd)
    if (!image) return
    const at = block.raw.indexOf(token.raw, from)
    const last = lines.at(-1)
    if (last && at >= 0 && !block.raw.slice(from, at).includes("\n")) last.push(image)
    else lines.push([image])
    if (at >= 0) from = at + token.raw.length
  })
  return lines
}

export function markdownImages(markdown: string, cwd: string): ChatImage[] {
  return markdown.includes("![") ? tokenImages(lex(markdown), cwd) : []
}

// The agent cannot see the pictures it links, so it is told about the ones that do not show.
export function brokenImagesNote(markdowns: string[], cwd: string): string | null {
  const lines = markdowns
    .flatMap((markdown) => markdownImages(markdown, cwd))
    .flatMap((image) => {
      const problem = image.path ? localImageProblem(image.path) : null
      return problem ? [`- ${image.path} (${problem === "too large" ? "over 20 MB" : problem})`] : []
    })
  if (lines.length === 0) return null
  return `[YellowCode: these images in your last reply could not be shown to the user]\n${[...new Set(lines)].join("\n")}`
}
