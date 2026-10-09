export function formatClock(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

export function cut(text: string, max: number): string {
  if (Bun.stringWidth(text) <= max) return text
  let result = ""
  for (const char of text) {
    if (Bun.stringWidth(`${result}${char}…`) > max) break
    result += char
  }
  return `${result}…`
}

export function cutPath(path: string, max: number): string {
  if (Bun.stringWidth(path) <= max) return path
  const parts = path.split("/")
  while (parts.length > 1 && Bun.stringWidth(`…/${parts.join("/")}`) > max) parts.shift()
  return parts.length > 1 ? `…/${parts.join("/")}` : cut(path, max)
}

export function modelName(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(\[.+\])?$/.exec(id)
  if (!match) return id
  const [, family = "", major, minor, suffix] = match
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`
  return suffix ? `${name} ${suffix}` : name
}
