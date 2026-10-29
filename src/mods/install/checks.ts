import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { apiVersion } from "../version.ts"
import { incompatibleText } from "../manifest.ts"
import type { ListedMod, ModList } from "./list.ts"
import type { InstallRecord } from "./record.ts"
import { dirEntries, hashEntries } from "./tree-hash.ts"

// Why the list took this version of a listed mod off, or null.
export function revokedListing(list: ModList, id: string, version: string | undefined): string | null {
  const item = list.revoked.find(
    (revoked) =>
      revoked.id === id &&
      (revoked.versions === "all" || (version !== undefined && revoked.versions.includes(version))),
  )
  return item?.reason ?? null
}

// The list's entry for a mod that may be installed, or why it may not.
export function listedEntry(list: ModList, id: string): ListedMod | string {
  const entry = list.mods.find((mod) => mod.id === id)
  const revoked = revokedListing(list, id, entry?.version)
  if (revoked !== null) return `${id}: Revoked: ${revoked}`
  if (!entry) return `${id} is not on the YellowCode list; for a mod on GitHub use yellowcode mod add github:owner/repo`
  if (!apiMatches(entry.api)) return `${id} ${entry.version} ${incompatibleText(entry.api)}`
  return entry
}

export function apiMatches(range: string): boolean {
  try {
    return Bun.semver.satisfies(apiVersion, range)
  } catch {
    return false
  }
}

export function editedLocally(folder: string, record: InstallRecord): boolean {
  return hashEntries(dirEntries(folder, [".git", "node_modules"]).files) !== record.treeHash
}

export function modFolders(mods: string): string[] {
  let names: string[]
  try {
    names = readdirSync(mods)
  } catch {
    return []
  }
  return names
    .filter((name) => name !== "node_modules" && !name.startsWith(".") && isFolder(join(mods, name)))
    .toSorted()
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
