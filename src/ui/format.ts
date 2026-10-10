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

export function formatTokens(n: number): string {
  if (n === 1_000_000) return "1m"
  if (n < 1000) return String(n)
  if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

export function formatSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatUntil(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const DAY = 86_400_000

function midnight(ms: number): number {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function formatAgo(ms: number, now: number): string {
  const elapsed = now - ms
  if (elapsed < 60_000) return "now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < DAY) return `${Math.floor(elapsed / 3_600_000)}h`
  const days = Math.round((midnight(now) - midnight(ms)) / DAY)
  if (days === 1) return "yesterday"
  if (days < 7) return `${days}d`
  if (days < 35) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30.4375)}mo`
  return `${Math.floor(days / 365)}y`
}
