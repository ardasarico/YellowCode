import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { homePath } from "../../paths.ts"
import { parseJson } from "../../json.ts"
import { MANIFEST, MOD_ID, readManifest } from "../manifest.ts"
import { editedLocally, listedEntry, modFolders, revokedCommit, revokedListing } from "./checks.ts"
import { installAt, type InstallResult } from "./install.ts"
import { type ModList, readCachedList, refreshList, REPO, SHA } from "./list.ts"
import { type InstallRecord, readRecord, recordPath } from "./record.ts"
import { bold, dim, done, problem, say, warn } from "../../cli-style.ts"

export const MOD_USAGE = [
  "       yellowcode mod add <id>",
  "       yellowcode mod add github:<owner>/<repo>[@<ref>]",
  "       yellowcode mod update [<id>]",
  "       yellowcode mod remove <id>",
  "       yellowcode mod list",
].join("\n")

const GITHUB = /^github:([\w.-]+\/[\w.-]+)(?:@([\w./-]+))?$/
const UNLISTED_WARNING =
  "is not on the YellowCode list. Nobody has reviewed it. It runs with the same access as YellowCode."

const short = (sha: string) => sha.slice(0, 7)

function fail(line: string): number {
  problem(line)
  return 1
}

export async function runModCommand(args: string[]): Promise<number> {
  const [command, target, ...rest] = args
  const mods = homePath("mods")
  const run = rest.length === 0 ? commandFor(command, target, mods) : null
  if (!run) {
    process.stderr.write(`Usage:\n${MOD_USAGE.replaceAll("       ", "  ")}\n`)
    return 1
  }
  say()
  const code = await run()
  say()
  return code
}

function commandFor(command: string | undefined, target: string | undefined, mods: string) {
  if (command === "add" && target)
    return () => (GITHUB.test(target) ? addUnlisted(target, mods) : addListed(target, mods))
  if (command === "update") return () => update(target, mods)
  if (command === "remove" && target) return () => remove(target, mods)
  if (command === "list" && !target) return () => listMods(mods)
  return null
}

async function addListed(id: string, mods: string): Promise<number> {
  const installed = installedState(mods, id)
  if (installed === "local") return fail(`${id} is a local mod; remove its folder first`)
  if (installed) return alreadyInstalled(id, installed)
  const list = await loadList()
  if (!list) return 1
  const entry = listedEntry(list, id)
  if (typeof entry === "string") return fail(entry)
  return finish(id, await installAt({ ...entry, listed: true }, mods))
}

async function addUnlisted(target: string, mods: string): Promise<number> {
  const [, repo = "", ref] = target.match(GITHUB) ?? []
  const sha = await resolveRef(repo, ref)
  if (!sha.ok) return fail(sha.problem)
  const id = await manifestId(repo, sha.value)
  if (!id.ok) return fail(id.problem)
  const list = await loadList()
  if (!list) return 1
  const revoked = revokedCommit(list, id.value, sha.value)
  if (revoked !== null) return fail(`${id.value} @ ${short(sha.value)}: Revoked: ${revoked}`)
  if (list.mods.some((mod) => mod.id === id.value))
    return fail(`${id.value} is a mod on the YellowCode list; install it with yellowcode mod add ${id.value}`)
  const installed = installedState(mods, id.value)
  if (installed === "local") return fail(`${id.value} is a local mod; remove its folder first`)
  if (installed) return alreadyInstalled(id.value, installed)

  warn(`${bold(id.value)} ${UNLISTED_WARNING}`)
  say(dim(`${repo} @ ${short(sha.value)}`))
  if (!(await ask("Install?"))) return fail("Nothing installed.")
  return finish(
    id.value,
    await installAt({ id: id.value, repo, sha: sha.value, treeHash: null, listed: false, ref }, mods),
  )
}

async function update(only: string | undefined, mods: string): Promise<number> {
  const ids = only ? [only] : recordedIds(mods)
  if (ids.length === 0) return (say("No installed mods to update."), 0)
  const list = await loadList()
  let failed = false
  for (const id of ids) {
    const record = readRecord(mods, id)
    const installed = installedState(mods, id)
    if (!record || !installed) {
      failed = true
      fail(installed === "local" ? `${id} is a local mod; it is not updated` : `${id} is not installed`)
      continue
    }
    if (editedLocally(join(mods, id), record)) {
      warn(`${bold(id)} was edited locally, not updated`)
      continue
    }
    const next = record.listed ? updateListed(id, record, mods, list) : updateUnlisted(id, record, mods, list)
    // oxlint-disable-next-line no-await-in-loop -- one mod at a time, since an unlisted one may ask first
    const updated = await next
    if (!updated) failed = true
  }
  return failed ? 1 : 0
}

async function updateListed(id: string, record: InstallRecord, mods: string, list: ModList | null): Promise<boolean> {
  if (!list) return false
  const entry = listedEntry(list, id)
  if (typeof entry === "string") return (fail(entry), false)
  if (entry.sha === record.sha) return (done(`${bold(id)} ${record.version} is up to date`), true)
  return finish(id, await installAt({ ...entry, listed: true }, mods), record.version) === 0
}

async function updateUnlisted(id: string, record: InstallRecord, mods: string, list: ModList | null): Promise<boolean> {
  const [, repo = "", ref] = record.source.match(GITHUB) ?? []
  if (!repo) return (fail(`${id}: the install record's source "${record.source}" is not github:owner/repo`), false)
  const sha = await resolveRef(repo, ref)
  if (!sha.ok) return (fail(`${id}: ${sha.problem}`), false)
  if (sha.value === record.sha) return (done(`${bold(id)} ${record.version} is up to date`), true)
  const revoked = list && revokedCommit(list, id, sha.value)
  if (revoked) return (fail(`${id} @ ${short(sha.value)}: Revoked: ${revoked}`), false)
  say(`${bold(id)} ${dim(`unlisted · ${repo} ${short(record.sha)} → ${short(sha.value)}`)}`)
  if (!(await ask(`Update ${id}?`))) return (say(`${bold(id)} not updated`), true)
  const result = await installAt({ id, repo, sha: sha.value, treeHash: null, listed: false, ref }, mods)
  return finish(id, result, record.version) === 0
}

async function remove(id: string, mods: string): Promise<number> {
  const installed = installedState(mods, id)
  if (installed === "local") return fail(`${id} is a local mod; remove its folder yourself`)
  if (!installed) return fail(`${id} is not installed`)
  if (!(await ask(`Remove ${id}?`))) return fail("Nothing removed.")
  rmSync(join(mods, id), { recursive: true, force: true })
  rmSync(recordPath(mods, id), { force: true })
  done(`Removed ${bold(id)}`)
  return 0
}

async function listMods(mods: string): Promise<number> {
  const folders = modFolders(mods)
  const installed = folders.map((id) => {
    const record = readRecord(mods, id)
    const manifest = readManifest(join(mods, id))
    const version = record?.version ?? (manifest.ok ? manifest.manifest.version : "?")
    return { id, version, note: !record ? "local" : record.listed ? "listed" : `unlisted ${record.source}` }
  })
  const list = await loadList()
  const available = (
    list?.mods.filter((mod) => !folders.includes(mod.id) && revokedListing(list, mod.id, mod.version) === null) ?? []
  ).map((mod) => ({ id: mod.id, version: mod.version, note: mod.description }))
  const width = Math.max(0, ...[...installed, ...available].map((row) => row.id.length + row.version.length))
  const row = ({ id, version, note }: { id: string; version: string; note: string }) =>
    say(`${bold(id)} ${version}${" ".repeat(width - id.length - version.length)}  ${dim(note)}`)
  installed.forEach(row)
  if (installed.length === 0) say("No mods installed.")
  if (available.length > 0) {
    say()
    say(dim("Available"))
  }
  available.forEach(row)
  return 0
}

function finish(id: string, result: InstallResult, from?: string): number {
  if (!result.ok) return fail(result.problem)
  const { record } = result
  const what = from
    ? `Updated ${bold(id)} ${dim(`${from} →`)} ${record.version}`
    : `Installed ${bold(id)} ${record.version}`
  done(`${what} ${dim(`@ ${short(record.sha)}`)}. Restart YellowCode to load it.`)
  return 0
}

function alreadyInstalled(id: string, record: InstallRecord): number {
  done(`${bold(id)} ${record.version} is already installed; run yellowcode mod update ${id}`)
  return 0
}

// The fetched list, else the cached one with a line saying so, else null after naming the problem.
async function loadList(): Promise<ModList | null> {
  const fetched = await refreshList()
  if (fetched.ok) return fetched.list
  const cached = readCachedList()
  if (!cached) return (fail(`Couldn't get the mod list: ${fetched.problem}`), null)
  warn(
    `Couldn't get the mod list (${fetched.problem}); using the copy cached ${new Date(cached.fetchedAt).toISOString()}`,
  )
  return cached.list
}

// The install record, "local" for a folder without one, or null when nothing is there.
function installedState(mods: string, id: string): InstallRecord | "local" | null {
  if (!MOD_ID.test(id)) return null
  const there = existsSync(join(mods, id))
  const record = readRecord(mods, id)
  if (!there) return null
  return record ?? "local"
}

function recordedIds(mods: string): string[] {
  return modFolders(mods).filter((id) => readRecord(mods, id))
}

type Found = { ok: true; value: string } | { ok: false; problem: string }

async function resolveRef(repo: string, ref: string | undefined): Promise<Found> {
  if (!REPO.test(repo)) return { ok: false, problem: `"${repo}" is not owner/repo` }
  if (ref?.includes("..")) return { ok: false, problem: `"${ref}" is not a branch, tag or commit` }
  const base = process.env["YELLOWCODE_GITHUB_API"] ?? "https://api.github.com"
  const name = ref ? `${repo}@${ref}` : repo
  try {
    const response = await fetch(`${base}/repos/${repo}/commits/${ref ?? "HEAD"}`, {
      headers: { Accept: "application/vnd.github.sha" },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404 || response.status === 422)
      return { ok: false, problem: `github:${name}: no such repository or ref` }
    if (!response.ok) return { ok: false, problem: `github:${name}: GitHub API HTTP ${response.status}` }
    const sha = (await response.text()).trim()
    if (!SHA.test(sha)) return { ok: false, problem: `github:${name}: GitHub did not answer with a commit SHA` }
    return { ok: true, value: sha }
  } catch (error) {
    return { ok: false, problem: `github:${name}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

// installAt needs the id before it downloads anything, so it is read from the manifest at that commit.
async function manifestId(repo: string, sha: string): Promise<Found> {
  const base = process.env["YELLOWCODE_RAW"] ?? "https://raw.githubusercontent.com"
  const missing = { ok: false, problem: `${repo} @ ${short(sha)} has no ${MANIFEST} with a mod id` } as const
  try {
    const response = await fetch(`${base}/${repo}/${sha}/${MANIFEST}`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return missing
    const json = parseJson(await response.text())
    const id: unknown =
      json.ok && typeof json.value === "object" && json.value !== null && "id" in json.value ? json.value.id : null
    return typeof id === "string" && MOD_ID.test(id) ? { ok: true, value: id } : missing
  } catch (error) {
    return { ok: false, problem: `${repo}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

let stdin: AsyncIterator<Uint8Array> | undefined
let buffered = ""
const decoder = new TextDecoder()

// Reads one line from stdin. Only y or yes is yes; a closed stdin is no.
async function ask(question: string): Promise<boolean> {
  process.stdout.write(`  ${question} ${dim("[y/N]")} `)
  const chunks = (stdin ??= Bun.stdin.stream()[Symbol.asyncIterator]())
  while (!buffered.includes("\n")) {
    // oxlint-disable-next-line no-await-in-loop -- the line arrives in chunks
    const chunk = await chunks.next()
    if (chunk.done) break
    buffered += decoder.decode(chunk.value, { stream: true })
  }
  const end = buffered.indexOf("\n")
  const line = end === -1 ? buffered : buffered.slice(0, end)
  buffered = end === -1 ? "" : buffered.slice(end + 1)
  // A typed answer is echoed by the terminal; a piped one is not.
  if (!process.stdin.isTTY) process.stdout.write(`${line}\n`)
  return /^(y|yes)$/i.test(line.trim())
}
