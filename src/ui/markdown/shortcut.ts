const COMBO = /^(?:(?:ctrl|shift|alt|option|cmd|meta|fn)\+)+(?:[^\s+]{1,9}|\+)$/i
const LONE = /^(?:esc|enter|tab)$/i

// The keys of a backticked shortcut such as `Ctrl+Shift+Z` or `Esc`, else null.
export function shortcutKeys(code: string): string[] | null {
  if (LONE.test(code)) return [code]
  if (!COMBO.test(code)) return null
  const keys = code.split("+")
  return code.endsWith("++") ? [...keys.slice(0, -2), "+"] : keys
}
