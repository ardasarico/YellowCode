const COMBO = /^(?:(?:ctrl|shift|alt|option|cmd|meta|fn)\+)+(?:[^\s+]{1,9}|\+)$/i
const LONE = /^(?:esc|enter|tab)$/i

// The keys of a backticked shortcut such as `Ctrl+Shift+Z` or `Esc`, else null.
export function shortcutKeys(code: string): string[] | null {
  if (LONE.test(code)) return [code]
  if (!COMBO.test(code)) return null
  const keys = code.split("+")
  return code.endsWith("++") ? [...keys.slice(0, -2), "+"] : keys
}

const IN_PROSE = /(?<![\w+])(?:(?:ctrl|shift|alt|option|cmd|meta|fn)\+)+[a-z0-9↑↓←→]{1,9}(?![\w+])/gi

// Prose split around shortcuts written without backticks, such as Ctrl+Z. Only combos count; a bare "Enter" or "Tab"
// in a sentence is usually just a word.
export function proseShortcuts(text: string): { text: string; keys: string[] | null }[] {
  const parts: { text: string; keys: string[] | null }[] = []
  let last = 0
  for (const match of text.matchAll(IN_PROSE)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), keys: null })
    parts.push({ text: match[0], keys: match[0].split("+") })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), keys: null })
  return parts
}
