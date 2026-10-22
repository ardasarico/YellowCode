import { spawnLimited } from "../spawn.ts"

const LIMIT = 15

export type FileEntry = { path: string; lower: string; lowerSegment: string }

let cached: Promise<FileEntry[]> | null = null

async function gitFiles(): Promise<string[]> {
  try {
    const result = await spawnLimited(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    })
    return result?.code === 0 ? result.stdout.split("\0").filter(Boolean) : []
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

export function fileEntries(files: string[]): FileEntry[] {
  return withFolders(files).map((path) => {
    const lower = path.toLowerCase()
    return { path, lower, lowerSegment: lastSegment(lower) }
  })
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

export function searchEntries(entries: FileEntry[], query: string): string[] {
  if (query === "" || (query.endsWith("/") && entries.some(({ path }) => path === query))) {
    return entries.flatMap(({ path }) => (isChild(path, query) ? [path] : [])).slice(0, LIMIT)
  }
  const needle = query.toLowerCase()
  const ranked: { entry: string; inSegment: boolean; gaps: number }[] = []
  for (const { path, lower, lowerSegment } of entries) {
    const inSegment = gaps(lowerSegment, needle)
    const inPath = inSegment === null ? gaps(lower, needle) : inSegment
    if (inPath !== null) ranked.push({ entry: path, inSegment: inSegment !== null, gaps: inPath })
  }
  ranked.sort((a, b) => Number(b.inSegment) - Number(a.inSegment) || a.gaps - b.gaps || a.entry.length - b.entry.length)
  return ranked.slice(0, LIMIT).map((item) => item.entry)
}

export async function suggestFiles(query: string): Promise<string[]> {
  cached ??= gitFiles().then(fileEntries)
  return searchEntries(await cached, query)
}
