import type { KeyEvent } from "@opentui/core"

const TYPING_GAP = 1000
const FREE_KEYS = new Set(["up", "down", "left", "right", "escape"])

let lastKeyAt = 0

export function noteKey(): void {
  lastKeyAt = Date.now()
}

// A key typed into the prompt just as an ask appears is not an answer: the first key is dropped when the key before
// it came less than a second earlier. Arrows and Esc always act. True when this key is dropped.
export function typingGuard(): (key: KeyEvent) => boolean {
  let previous = lastKeyAt
  let first = true
  return (key) => {
    const now = Date.now()
    const gap = now - previous
    previous = now
    if (!first || key.ctrl || key.meta) return false
    first = false
    return gap < TYPING_GAP && !FREE_KEYS.has(key.name)
  }
}
