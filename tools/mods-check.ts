// Checks mods.json for review: the schema; that no mod left mods[] since origin/main without a revoke of every version;
// then every entry added or changed against origin/main (all with --all) is installed at its SHA into a throwaway mods
// folder, which checks the tree hash, symlinks, the manifest and the dependency install, and its manifest must match
// the entry. Prints the link to read for each entry; exits 1 on any failure. YELLOWCODE_CODELOAD overrides the
// download host.
/* oxlint-disable no-await-in-loop */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { type Manifest, readManifest } from "../src/mods/manifest.ts"
import { installAt } from "../src/mods/install/install.ts"
import { type ListedMod, type ModList, parseList } from "../src/mods/install/list.ts"
import { parseJson } from "../src/json.ts"

const repo = join(import.meta.dir, "..")

// `from` is "" for the working copy and "origin/main:" for the one to compare against.
function load(text: string, from: string): ModList {
  const json = parseJson(text)
  if (!json.ok) throw new Error(`${from}mods.json is not valid JSON`)
  const parsed = parseList(json.value)
  if (!parsed.ok) throw new Error(`${from}${parsed.problem}`)
  return parsed.list
}

function mainList(): ListedMod[] {
  const show = Bun.spawnSync(["git", "show", "origin/main:mods.json"], { cwd: repo, stderr: "ignore" })
  return show.exitCode === 0 ? load(show.stdout.toString(), "origin/main:").mods : []
}

// A mod that leaves mods[] would keep loading where it is installed and never update again, so it must be revoked.
export function droppedProblems(before: readonly ListedMod[], list: ModList): string[] {
  return before
    .filter((old) => !list.mods.some((mod) => mod.id === old.id))
    .filter((old) => !list.revoked.some((entry) => entry.id === old.id && entry.versions === "all"))
    .map(
      (old) =>
        `${old.id} was taken out of mods[] without a revoke; add { "id": "${old.id}", "versions": "all", "reason": "…" } to revoked[] so installed copies turn off`,
    )
}

// What differs between the list entry and the manifest at its commit, or null.
export function manifestMismatch(mod: ListedMod, manifest: Manifest): string | null {
  for (const field of ["name", "description", "version", "api", "agents"] as const) {
    const listed = JSON.stringify(mod[field])
    const actual = JSON.stringify(manifest[field])
    if (listed !== actual) return `${field} is ${listed} in the list but ${actual} in the manifest`
  }
  return null
}

const same = (a: ListedMod, b: ListedMod) => JSON.stringify(a) === JSON.stringify(b)

const SCREENSHOT_LIMIT = 1024 * 1024
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]

// Why a screenshot the manifest names cannot be shown on the website, or null.
export function screenshotProblem(modFolder: string, path: string): string | null {
  const file = join(modFolder, path)
  let size: number
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return `screenshot ${path} is not a file`
    size = stat.size
  } catch {
    return `screenshot ${path} is not in the commit`
  }
  if (size > SCREENSHOT_LIMIT) return `screenshot ${path} is over 1 MB`
  const head = readFileSync(file).subarray(0, PNG.length)
  const starts = (magic: number[]) => magic.every((byte, index) => head[index] === byte)
  if (!starts(PNG) && !starts(JPEG)) return `screenshot ${path} is not a PNG or JPEG image`
  return null
}

async function check(mod: ListedMod): Promise<string | null> {
  const folder = mkdtempSync(join(tmpdir(), "yellowcode-mods-check-"))
  try {
    const installed = await installAt(
      { id: mod.id, repo: mod.repo, sha: mod.sha, treeHash: mod.treeHash, listed: true },
      folder,
    )
    if (!installed.ok) return installed.problem
    const manifest = readManifest(join(folder, mod.id))
    if (!manifest.ok) return manifest.problem
    const screenshots = (manifest.manifest.screenshots ?? []).map((path) =>
      screenshotProblem(join(folder, mod.id), path),
    )
    return manifestMismatch(mod, manifest.manifest) ?? screenshots.find((problem) => problem !== null) ?? null
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

function reviewLink(mod: ListedMod, old: ListedMod | undefined): string {
  if (old && old.repo === mod.repo && old.sha !== mod.sha)
    return `https://github.com/${mod.repo}/compare/${old.sha}...${mod.sha}`
  return `https://github.com/${mod.repo}/tree/${mod.sha}`
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { all: { type: "boolean", default: false } } })
  let failed = false
  try {
    const list = load(readFileSync(join(repo, "mods.json"), "utf8"), "")
    const main = mainList()
    for (const problem of droppedProblems(main, list)) {
      failed = true
      console.log(`✗ ${problem}`)
    }
    const before = new Map(main.map((mod) => [mod.id, mod]))
    const changed = values.all
      ? list.mods
      : list.mods.filter((mod) => !before.has(mod.id) || !same(mod, before.get(mod.id)!))
    if (changed.length === 0) console.log("mods.json: no changed entries")
    for (const mod of changed) {
      const old = before.get(mod.id)
      const problem = await check(mod)
      if (problem) {
        failed = true
        console.log(`✗ ${mod.id} ${mod.version}: ${problem}`)
      } else {
        console.log(`✓ ${mod.id} ${mod.version}: ${reviewLink(mod, old)}`)
      }
    }
  } catch (error) {
    failed = true
    console.log(error instanceof Error ? error.message : String(error))
  }
  process.exit(failed ? 1 : 0)
}
