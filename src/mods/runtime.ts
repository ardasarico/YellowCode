import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { compiled } from "../build-info.ts"
import { log } from "../log/log.ts"
import { installModLoader } from "./compiled-loader.ts"

const REPO = resolve(import.meta.dir, "../..")

// A mod outside the repo imports these by name; links in the mods folder's node_modules make them resolve to
// YellowCode's own copies, so there is one Solid and one OpenTUI. A runtime Bun.plugin onResolve cannot map bare
// imports from files outside the repo.
const LINKS: [string, string][] = [
  ["solid-js", join(REPO, "node_modules/solid-js")],
  ["@opentui/core", join(REPO, "node_modules/@opentui/core")],
  ["@opentui/solid", join(REPO, "node_modules/@opentui/solid")],
  ["yellowcode", REPO],
]

function linkTarget(path: string): string | null | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
    return readlinkSync(path)
  } catch {
    return undefined
  }
}

export function linkRuntime(modsFolder: string): void {
  if (compiled) return installModLoader(modsFolder)
  for (const [name, target] of LINKS) {
    const path = join(modsFolder, "node_modules", name)
    const current = linkTarget(path)
    if (current === target) continue
    if (current === null) {
      log.warn(`mods: ${path} is not a link, leaving it alone`)
      continue
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      if (current !== undefined) rmSync(path)
      symlinkSync(target, path, "dir")
    } catch (error) {
      log.warn(`mods: cannot link ${path}`, error)
    }
  }
}
