export type KeyBinding = { name: string; ctrl: boolean; shift: boolean; meta: boolean }

type KeyEventLike = { name: string; ctrl: boolean; shift: boolean; meta: boolean; option?: boolean }

const MODIFIERS = new Set(["ctrl", "shift", "alt", "meta", "option"])

export function parseKey(text: string): KeyBinding | null {
  const parts = text.trim().toLowerCase().split("+")
  const name = parts.pop()
  if (!name || parts.some((part) => !MODIFIERS.has(part))) return null
  const alt = parts.includes("alt") || parts.includes("meta") || parts.includes("option")
  return { name, ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), meta: alt }
}

export function matches(binding: KeyBinding, key: KeyEventLike): boolean {
  const meta = key.meta || key.option === true
  if (binding.ctrl !== key.ctrl || binding.shift !== key.shift || binding.meta !== meta) return false
  // A terminal without the kitty keyboard protocol sends NUL for ctrl+`, which reads as ctrl+space.
  if (binding.name === "`" && binding.ctrl && key.name === "space") return true
  return binding.name === key.name.toLowerCase()
}
