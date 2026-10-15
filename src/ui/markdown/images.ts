import { basename, extname, resolve } from "node:path"
import { Lexer, marked, type Token } from "marked"
import type { ChatImage } from "../../session/types.ts"

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export function isLocalImage(href: string): boolean {
  return !/^[a-z][a-z\d+.-]*:/i.test(href)
}

function localImage(token: Token, cwd: string): ChatImage | null {
  if (token.type !== "image" || !isLocalImage(String(token.href))) return null
  const path = resolve(cwd, String(token.href))
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
  return markdown.includes("![") ? tokenImages(Lexer.lex(markdown, { gfm: true }), cwd) : []
}
