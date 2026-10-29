// Checks mods.json for review: the schema, then every entry added or changed against origin/main (all with --all) is
// installed at its SHA into a throwaway mods folder, which checks the tree hash, symlinks, the manifest and the
// dependency install, and its manifest must match the entry. Prints the link to read for each entry; exits 1 on any
// failure. YELLOWCODE_CODELOAD overrides the download host.
/* oxlint-disable no-await-in-loop */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { readManifest } from "../src/mods/manifest.ts"
import { installAt } from "../src/mods/install/install.ts"
import { type ListedMod, parseList } from "../src/mods/install/list.ts"
import { parseJson } from "../src/json.ts"

const { values } = parseArgs({ options: { all: { type: "boolean", default: false } } })

const repo = join(import.meta.dir, "..")

// `from` is "" for the working copy and "origin/main:" for the one to compare against.
function load(text: string, from: string): ListedMod[] {
  const json = parseJson(text)
  if (!json.ok) throw new Error(`${from}mods.json is not valid JSON`)
  const parsed = parseList(json.value)
  if (!parsed.ok) throw new Error(`${from}${parsed.problem}`)
  return parsed.list.mods
}

function mainList(): ListedMod[] {
  const show = Bun.spawnSync(["git", "show", "origin/main:mods.json"], { cwd: repo, stderr: "ignore" })
  return show.exitCode === 0 ? load(show.stdout.toString(), "origin/main:") : []
}

const same = (a: ListedMod, b: ListedMod) => JSON.stringify(a) === JSON.stringify(b)

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
    if (manifest.manifest.version !== mod.version)
      return `version is ${mod.version} in the list but ${manifest.manifest.version} in the manifest`
    if (manifest.manifest.api !== mod.api)
      return `api is ${mod.api} in the list but ${manifest.manifest.api} in the manifest`
    if (JSON.stringify(manifest.manifest.agents) !== JSON.stringify(mod.agents))
      return `agents is ${JSON.stringify(mod.agents)} in the list but ${JSON.stringify(manifest.manifest.agents)} in the manifest`
    return null
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

function reviewLink(mod: ListedMod, old: ListedMod | undefined): string {
  if (old && old.repo === mod.repo) return `https://github.com/${mod.repo}/compare/${old.sha}...${mod.sha}`
  return `https://github.com/${mod.repo}/tree/${mod.sha}`
}

let failed = false
try {
  const mods = load(readFileSync(join(repo, "mods.json"), "utf8"), "")
  const before = new Map(mainList().map((mod) => [mod.id, mod]))
  const changed = values.all ? mods : mods.filter((mod) => !before.has(mod.id) || !same(mod, before.get(mod.id)!))
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
