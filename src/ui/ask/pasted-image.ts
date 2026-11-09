import type { InputRenderable, KeyEvent } from "@opentui/core"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PromptImage } from "../../agent/agent.ts"
import { log } from "../../log/log.ts"
import { readClipboard } from "../../input/clipboard.ts"

let answersDir: string | undefined
let saves = 0

// An answer carries text only on every agent's ask path, so a pasted picture goes as a file the agent reads.
function saved(image: PromptImage): string | null {
  try {
    answersDir ??= mkdtempSync(join(tmpdir(), "yellowcode-answers-"))
    const path = join(answersDir, `${++saves}.${image.mediaType.split("/")[1] ?? "png"}`)
    writeFileSync(path, Buffer.from(image.base64, "base64"))
    return path
  } catch (error) {
    log.warn("pasted answer image could not be saved", String(error))
    return null
  }
}

// What a Ctrl+V brings into an answer: a picture saved as a file, a copied image file, or the copied text.
async function pasted(): Promise<{ path: string } | { text: string } | null> {
  const content = await readClipboard().catch((error: unknown) => {
    log.warn("clipboard read for an answer failed", String(error))
    return null
  })
  if (content?.kind === "text") return { text: content.text.replaceAll("\n", " ") }
  const path = content?.kind === "image" ? saved(content.image) : content?.kind === "path" ? content.path : null
  return path ? { path } : null
}

// Per ask: takes a Ctrl+V meant for the focused answer field, where a picture lands as `[Image N: path]`. True when
// the key is taken.
export function answerPaste(): (key: KeyEvent, field: InputRenderable | undefined) => boolean {
  let images = 0
  return (key, field) => {
    if (!field || !(key.ctrl || key.super) || key.name !== "v" || key.shift || key.meta) return false
    key.preventDefault()
    void pasted().then((content) => {
      if (!content || field.isDestroyed) return
      if ("text" in content) return field.insertText(content.text)
      const before = field.plainText.slice(0, field.cursorOffset)
      field.insertText(`${before === "" || before.endsWith(" ") ? "" : " "}[Image ${++images}: ${content.path}]`)
    })
    return true
  }
}
