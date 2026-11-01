// Makes a release: bun run release beta|stable [--dry-run] [--from <branch>]
// beta: commits the new version on top of main, builds it, and after a yes pushes it with its tag, publishes a GitHub
// prerelease and points the beta channel at it. stable: rebuilds the last beta's commit under the stable version,
// checks that it holds the same code, and publishes it. --from <branch> releases a stable hotfix from that branch.
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import packageJson from "../package.json"
import { type Channels, parseChannels, type Platform, type Release } from "../src/update/channels.ts"
import { build, bundleHash, DIST, PLATFORMS } from "./build.ts"
import { thirdPartyLicenses } from "./licenses.ts"
import { formula, writeNpmPackages } from "./packages.ts"

const REPO = resolve(import.meta.dir, "..")
const GITHUB = "ardasarico/YellowCode"
const TAP = "ardasarico/homebrew-tap"
const CHANNELS_FILE = "release/channels.json"
const LICENSES = "THIRD_PARTY_LICENSES.txt"

function git(...args: string[]): string {
  return run(["git", ...args], REPO)
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function fail(message: string): never {
  console.error(`release: ${message}`)
  process.exit(1)
}

const base = (version: string) => version.replace(/-beta\.\d+$/, "")
const betaNumber = (version: string) => Number(/-beta\.(\d+)$/.exec(version)?.[1] ?? 0)
const newer = (a: string, b: string) => Bun.semver.order(a, b) === 1

function bump(version: string, part: "minor" | "patch"): string {
  const [major = 0, minor = 0, patch = 0] = base(version).split(".").map(Number)
  return part === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
}

// The beta after the current one, or the first beta of the next version once that version is out as stable.
function nextBeta(current: string, stable: Release | null): string {
  if (stable && !newer(base(current), stable.version)) return `${bump(stable.version, "minor")}-beta.1`
  return current.includes("-beta.") ? `${base(current)}-beta.${betaNumber(current) + 1}` : `${current}-beta.1`
}

function ask(question: string, fallback: string): string {
  return prompt(`${question} [${fallback}]`)?.trim() || fallback
}

function readChannels(): Channels {
  const result = parseChannels(readFileSync(join(REPO, CHANNELS_FILE), "utf8"))
  if (!result.ok) fail(result.problem)
  return result.channels
}

// A dry run builds committed code too, so it allows local changes.
function checkRepo(branch: string, dryRun: boolean): void {
  if (git("branch", "--show-current") !== "main") fail("run it on main")
  if (!dryRun && git("status", "--porcelain")) fail("the working tree has changes; commit or stash them first")
  git("fetch", "origin", "--tags")
  if (git("rev-list", "--count", "HEAD..origin/main") !== "0") fail("main is behind origin/main; pull first")
  if (branch !== "main" && git("rev-list", "--count", `${branch}..origin/${branch}`) !== "0")
    fail(`${branch} is behind origin/${branch}`)
}

// A detached checkout of a commit inside dist/, so main's files stay as they are until the release is confirmed.
function checkout(commit: string): string {
  const folder = join(DIST, ".release")
  rmSync(folder, { recursive: true, force: true })
  run(["git", "worktree", "prune"], REPO)
  git("worktree", "add", "--detach", folder, commit)
  return folder
}

async function pack(
  version: string,
  channel: string,
  source: string,
): Promise<{ files: string[]; assets: Release["assets"] }> {
  const folder = join(DIST, "release", `v${version}`)
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  await Promise.all(PLATFORMS.map((platform) => build(platform, { version, channel, source })))
  const asset = (platform: Platform) => {
    const inner = join(folder, platform)
    mkdirSync(inner)
    cpSync(join(DIST, `yellowcode-${platform}`), join(inner, "yellowcode"))
    cpSync(join(REPO, "LICENSE"), join(inner, "LICENSE"))
    writeFileSync(join(inner, LICENSES), thirdPartyLicenses(join(DIST, ".stage", platform)))
    const name = `yellowcode-${platform}.tar.gz`
    // No owner names or macOS attributes in the archive: it is public, and Linux tar warns about the attributes.
    run(
      [
        "tar",
        "--no-xattrs",
        "--no-mac-metadata",
        "--uid",
        "0",
        "--gid",
        "0",
        "--uname",
        "",
        "--gname",
        "",
        "-czf",
        join(folder, name),
        "-C",
        inner,
        "yellowcode",
        "LICENSE",
        LICENSES,
      ],
      REPO,
    )
    rmSync(inner, { recursive: true })
    const sha256 = createHash("sha256")
      .update(readFileSync(join(folder, name)))
      .digest("hex")
    return { url: `https://github.com/${GITHUB}/releases/download/v${version}/${name}`, sha256 }
  }
  const assets: Release["assets"] = {
    "darwin-arm64": asset("darwin-arm64"),
    "darwin-x64": asset("darwin-x64"),
    "linux-x64": asset("linux-x64"),
    "linux-arm64": asset("linux-arm64"),
  }
  const names = PLATFORMS.map((platform) => `yellowcode-${platform}.tar.gz`)
  const sums = PLATFORMS.map((platform, index) => `${assets[platform].sha256}  ${names[index]}`)
  writeFileSync(join(folder, "SHA256SUMS"), `${sums.join("\n")}\n`)
  return { files: [...names, "SHA256SUMS"].map((name) => join(folder, name)), assets }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean", default: false }, from: { type: "string" } },
})
const channel = positionals[0]
if (channel !== "beta" && channel !== "stable") fail("usage: bun run release beta|stable [--dry-run] [--from <branch>]")
if (values.from && channel !== "stable") fail("--from is for a stable hotfix")
const dryRun = values["dry-run"]
const branch = values.from ?? "main"

checkRepo(branch, dryRun)
const channels = readChannels()
const steps: string[] = []
let version: string
let commit: string
let source: string

if (channel === "beta") {
  const current = packageJson.version
  version = ask("Beta version", nextBeta(current, channels.stable))
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) fail(`${version} is not like 1.2.3-beta.4`)
  if (channels.beta && !newer(version, channels.beta.version))
    fail(`${version} is not newer than ${channels.beta.version}`)
  source = checkout("HEAD")
  const manifest = join(source, "package.json")
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(`"version": "${current}"`, `"version": "${version}"`))
  run(["git", "commit", "-q", "-m", `release: v${version}`, "package.json"], source)
  commit = run(["git", "rev-parse", "HEAD"], source)
  steps.push(`fast-forward main to ${commit.slice(0, 7)} (release: v${version})`)
} else {
  if (values.from) {
    if (!channels.stable) fail("there is no stable release to fix")
    version = ask("Hotfix version", bump(channels.stable.version, "patch"))
    commit = git("rev-parse", `origin/${branch}`)
  } else {
    if (!channels.beta) fail("there is no beta to make stable")
    version = base(channels.beta.version)
    commit = channels.beta.commit
  }
  if (channels.stable && !newer(version, channels.stable.version))
    fail(`${version} is not newer than ${channels.stable.version}`)
  source = checkout(commit)
}

const bundle = await bundleHash(source)
if (channel === "stable" && !values.from && bundle !== channels.beta?.bundle)
  fail(`the rebuild of ${commit.slice(0, 7)} differs from the beta's code; nothing was published`)
const { files, assets } = await pack(version, channel, source)
const tag = `v${version}`
const release: Release = { version, commit, bundle, assets }
const next: Channels = { ...channels, [channel]: release }
const npmFolders = writeNpmPackages(version)
const formulaFile = join(DIST, "brew", "yellowcode.rb")
mkdirSync(join(DIST, "brew"), { recursive: true })
writeFileSync(formulaFile, formula(release))
// npm and the tap are public, so they wait for the repo to be public too; a private release only reaches people with
// access to the repo.
const isPublic = run(["gh", "repo", "view", GITHUB, "--json", "visibility", "-q", ".visibility"], REPO) === "PUBLIC"
const npmTag = channel === "beta" ? "beta" : "latest"
if (isPublic && !dryRun && Bun.spawnSync(["npm", "whoami"]).exitCode !== 0) fail("log in to npm first (npm login)")

steps.push(
  `tag ${tag} on ${commit.slice(0, 7)}`,
  channel === "beta" ? "push main and the tag to origin" : "push the tag to origin",
  `publish the GitHub ${channel === "beta" ? "prerelease" : "release"} ${tag} with ${files.length} files`,
  `point ${channel} at ${tag} in ${CHANNELS_FILE}, commit and push it`,
  isPublic
    ? `publish ${npmFolders.length} npm packages under the ${npmTag} tag`
    : `skip npm: the repo is private (packages are in dist/npm)`,
  ...(channel === "stable"
    ? [isPublic ? `update Formula/yellowcode.rb in ${TAP} and push it` : `skip Homebrew: the repo is private`]
    : []),
)
const unpushed = git("log", "--oneline", `origin/main..${channel === "beta" ? commit : "HEAD"}`)
console.log(`\n${channel} ${tag} from ${commit.slice(0, 7)}`)
for (const file of files) console.log(`  ${file.slice(REPO.length + 1)}`)
for (const platform of PLATFORMS) console.log(`  ${assets[platform].sha256}  ${platform}`)
if (unpushed) console.log(`\nThese commits on main reach origin too:\n${unpushed}`)
console.log(`\nSteps:\n${steps.map((step, index) => `  ${index + 1}. ${step}`).join("\n")}\n`)

git("worktree", "remove", "--force", source)
if (dryRun) {
  console.log("Dry run: nothing was pushed or published.")
  process.exit(0)
}
if (ask("Publish?", "no").toLowerCase() !== "yes") fail("stopped; nothing was pushed or published")

if (channel === "beta") git("merge", "--ff-only", "-q", commit)
git("tag", tag, commit)
git("push", "--atomic", "origin", ...(channel === "beta" ? ["main"] : []), tag)
run(
  [
    "gh",
    "release",
    "create",
    tag,
    ...files,
    "--repo",
    GITHUB,
    "--title",
    tag,
    "--generate-notes",
    ...(channel === "beta" ? ["--prerelease"] : ["--latest"]),
  ],
  REPO,
)
writeFileSync(join(REPO, CHANNELS_FILE), `${JSON.stringify(next, null, 2)}\n`)
git("commit", "-q", "-m", `release: point ${channel} at ${tag}`, CHANNELS_FILE)
git("push", "origin", "main")
if (isPublic) {
  // The platform packages go first, so the main package never points at a version that is not there yet.
  for (const folder of npmFolders) run(["npm", "publish", "--access", "public", "--tag", npmTag], folder)
  if (channel === "stable") {
    const tap = join(DIST, ".tap")
    rmSync(tap, { recursive: true, force: true })
    run(["gh", "repo", "clone", TAP, tap, "--", "--depth", "1", "-q"], REPO)
    mkdirSync(join(tap, "Formula"), { recursive: true })
    cpSync(formulaFile, join(tap, "Formula", "yellowcode.rb"))
    run(["git", "add", "Formula/yellowcode.rb"], tap)
    run(["git", "commit", "-q", "-m", `yellowcode ${version}`], tap)
    run(["git", "push", "-q", "origin", "HEAD"], tap)
  }
}
console.log(`Published ${tag}.`)
