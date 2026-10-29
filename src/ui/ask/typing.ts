import type { KeyEvent } from "@opentui/core"
import { createSignal } from "solid-js"

const TYPING_GAP = 1000
const HOLD_LIMIT = 3000
const FREE_KEYS = new Set(["up", "down", "left", "right", "escape"])

let lastKeyAt = 0
// The key before the latest one: a handler of the latest key reads the pause before it from this.
let keyBefore = 0
// The hold ran out at its limit while the user went on typing at the prompt; that typing never sends.
let rushed = false

// Runs for every key before any other key handler (index.tsx registers it first).
export function noteKey(): void {
  keyBefore = lastKeyAt
  lastKeyAt = Date.now()
  if (lastKeyAt - keyBefore >= TYPING_GAP) rushed = false
}

const [held, setHeld] = createSignal(false)
let holdEnds = 0
let asking: () => boolean = () => false
let release: ReturnType<typeof setTimeout> | undefined

export { held }

function endHold(): void {
  clearTimeout(release)
  setHeld(false)
}

// The hold ends a second after the last key. While an ask is open it ends only so, since a held key could answer
// it; at the prompt it also ends HOLD_LIMIT after the cancel.
function settle(): void {
  clearTimeout(release)
  const now = Date.now()
  if (now - lastKeyAt >= TYPING_GAP) return endHold()
  if (!asking() && now >= holdEnds) {
    rushed = true
    return endHold()
  }
  const until = asking() ? lastKeyAt + TYPING_GAP : Math.min(lastKeyAt + TYPING_GAP, holdEnds)
  release = setTimeout(settle, until - now)
}

// An ask that the agent takes back while the user types an answer for it leaves the rest of that typing to the prompt,
// or to the next ask, where it is no answer: keys are dropped while they keep coming less than a second apart.
export function holdKeys(isAsking: () => boolean): void {
  const now = Date.now()
  if (now - lastKeyAt >= TYPING_GAP) return
  asking = isAsking
  holdEnds = now + HOLD_LIMIT
  setHeld(true)
  settle()
}

// True when this key is dropped. Arrows, Esc and keys with Ctrl or Meta always act.
export function heldKey(key: KeyEvent): boolean {
  if (!held()) return false
  if (Date.now() - keyBefore >= TYPING_GAP) {
    endHold()
    return false
  }
  settle()
  return held() && !key.ctrl && !key.meta && !FREE_KEYS.has(key.name)
}

// True while a submit belongs to typing the hold let through at its limit; the prompt keeps the text.
export function rushedSubmit(): boolean {
  return rushed
}

// A key typed into the prompt just as an ask appears is not an answer: the first key is dropped when the key before
// it (any key, held ones too) came less than a second earlier. Arrows and Esc always act. True when this key is
// dropped.
export function typingGuard(): (key: KeyEvent) => boolean {
  let first = true
  return (key) => {
    if (!first || key.ctrl || key.meta) return false
    first = false
    return Date.now() - keyBefore < TYPING_GAP && !FREE_KEYS.has(key.name)
  }
}
