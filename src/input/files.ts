const LIMIT = 15

let cached: string[] | null = null

function gitFiles(): string[] {
  try {
    const result = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "ignore",
    })
    if (result.exitCode !== 0) return []
    return result.stdout.toString().split("\0").filter(Boolean)
  } catch {
    return []
  }
}

export function withFolders(files: string[]): string[] {
  const entries = new Set<string>()
  for (const file of files) {
    entries.add(file)
    for (let slash = file.indexOf("/"); slash !== -1; slash = file.indexOf("/", slash + 1)) {
      entries.add(file.slice(0, slash + 1))
    }
  }
  return [...entries].toSorted()
}

function lastSegment(entry: string): string {
  const bare = entry.endsWith("/") ? entry.slice(0, -1) : entry
  return bare.slice(bare.lastIndexOf("/") + 1)
}

function gaps(text: string, needle: string): number | null {
  if (text.includes(needle)) return 0
  let at = -1
  let count = 0
  for (const char of needle) {
    const next = text.indexOf(char, at + 1)
    if (next === -1) return null
    if (at !== -1 && next > at + 1) count++
    at = next
  }
  return count
}

function isChild(entry: string, folder: string): boolean {
  return entry !== folder && entry.startsWith(folder) && !entry.slice(folder.length, -1).includes("/")
}

export function searchEntries(entries: string[], query: string): string[] {
  if (query === "" || (query.endsWith("/") && entries.includes(query))) {
    return entries.filter((entry) => isChild(entry, query)).slice(0, LIMIT)
  }
  const needle = query.toLowerCase()
  const ranked: { entry: string; inSegment: boolean; gaps: number }[] = []
  for (const entry of entries) {
    const inSegment = gaps(lastSegment(entry).toLowerCase(), needle)
    const inPath = inSegment === null ? gaps(entry.toLowerCase(), needle) : inSegment
    if (inPath !== null) ranked.push({ entry, inSegment: inSegment !== null, gaps: inPath })
  }
  ranked.sort((a, b) => Number(b.inSegment) - Number(a.inSegment) || a.gaps - b.gaps || a.entry.length - b.entry.length)
  return ranked.slice(0, LIMIT).map((item) => item.entry)
}

export function suggestFiles(query: string): string[] {
  cached ??= withFolders(gitFiles())
  return searchEntries(cached, query)
}
