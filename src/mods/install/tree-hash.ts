import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type TreeEntry = [path: string, content: Uint8Array]

const hex = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex")

// Like Go's h1 hash: sha256 over the sorted lines "<sha256 hex of file>  <path>\n". Modes and timestamps are left out,
// so the hash survives re-compression and any tar producer.
export function hashEntries(entries: TreeEntry[]): string {
  const lines = entries
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => `${hex(content)}  ${path}\n`)
  return "sha256-" + new Bun.CryptoHasher("sha256").update(lines.join("")).digest("base64")
}

// Files under root with "/" paths. Symlinks are not followed or hashed; they come back in `symlinks`.
export function dirEntries(
  root: string,
  skip: readonly string[] = [".git"],
): { files: TreeEntry[]; symlinks: string[] } {
  const files: TreeEntry[] = []
  const symlinks: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      if (skip.includes(name)) continue
      const path = join(dir, name)
      const rel = prefix + name
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) symlinks.push(rel)
      else if (stat.isDirectory()) walk(path, `${rel}/`)
      else files.push([rel, readFileSync(path)])
    }
  }
  walk(root, "")
  return { files, symlinks }
}

// Hashes a codeload-style tarball in memory, without its "<repo>-<sha>/" top folder. Bun leaves symlinks out of
// files(), so this cannot refuse them; the installer hashes the extracted folder instead.
export async function hashTarball(bytes: Uint8Array): Promise<string> {
  const files = [...(await new Bun.Archive(bytes).files())]
    .map(([path, file]) => [path.split("/").slice(1).join("/"), file] as const)
    .filter(([rel]) => rel)
  const entries = await Promise.all(files.map(async ([rel, file]): Promise<TreeEntry> => [rel, await file.bytes()]))
  return hashEntries(entries)
}
