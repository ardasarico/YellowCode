// Builds one standalone binary per platform into dist/:
// bun run build [--target <platform>]... [--version <version>] [--channel <channel>]
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import solid from "@opentui/solid/bun-plugin"
import packageJson from "../package.json"
import { skillFiles } from "../src/skills/embed.ts"

const TARGETS = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
} satisfies Record<string, Bun.Build.CompileTarget>
export type Platform = keyof typeof TARGETS
export const PLATFORMS = Object.keys(TARGETS).filter(isPlatform)

function isPlatform(name: string): name is Platform {
  return name in TARGETS
}

const REPO = resolve(import.meta.dir, "..")
export const DIST = join(REPO, "dist")
const SOURCES = [
  "src",
  "assets",
  "themes",
  "types",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "patches",
]

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

// Each platform gets its own copy of the app with only that platform's native packages installed, so a binary never
// carries another platform's libraries.
function stage(platform: Platform, source: string, folderName: string = platform): string {
  const folder = join(DIST, ".stage", folderName)
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  for (const name of SOURCES) cpSync(join(source, name), join(folder, name), { recursive: true })
  const [os, cpu] = platform.split("-")
  run(
    [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--production",
      "--ignore-scripts",
      `--os=${os}`,
      `--cpu=${cpu}`,
    ],
    folder,
  )
  return folder
}

export type BuildOptions = {
  version: string
  channel: string
  // The checkout to build; a release builds a commit from a temporary worktree.
  source?: string
}

function defines({ version, channel, source = REPO }: BuildOptions): Record<string, string> {
  return {
    BUILD_VERSION: JSON.stringify(version),
    BUILD_COMMIT: JSON.stringify(run(["git", "rev-parse", "--short", "HEAD"], source)),
    BUILD_CHANNEL: JSON.stringify(channel),
    SKILL_FILES: JSON.stringify(skillFiles(source)),
  }
}

export async function build(platform: Platform, options: BuildOptions): Promise<string> {
  const folder = stage(platform, options.source ?? REPO)
  const outfile = join(DIST, `yellowcode-${platform}`)
  const result = await Bun.build({
    entrypoints: [join(folder, "src/index.tsx")],
    compile: {
      target: TARGETS[platform],
      outfile,
      autoloadPackageJson: true,
      autoloadBunfig: false,
      autoloadDotenv: false,
    },
    define: defines(options),
    plugins: [solid],
  })
  if (!result.success) throw new AggregateError(result.logs, `build for ${platform} failed`)
  return outfile
}

// A hash of the app's code at a checkout, built with a fixed version and channel. A stable release is rebuilt from its
// beta's commit; the same hash proves the rebuild holds the same code.
export async function bundleHash(source = REPO): Promise<string> {
  const folder = stage("darwin-arm64", source, "bundle")
  const result = await Bun.build({
    entrypoints: [join(folder, "src/index.tsx")],
    target: "bun",
    // Native packages differ per platform and are not the app's code.
    external: ["@opentui/core-*", "@resvg/resvg-js-*"],
    define: defines({ version: "0.0.0", channel: "none", source }),
    plugins: [solid],
  })
  const output = result.outputs.find((file) => file.kind === "entry-point")
  if (!result.success || !output) throw new AggregateError(result.logs, "bundle failed")
  const text = (await output.text()).replaceAll(folder, "<stage>")
  return createHash("sha256").update(text).digest("hex")
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      target: { type: "string", multiple: true },
      version: { type: "string" },
      channel: { type: "string", default: "stable" },
    },
  })
  const targets = (values.target ?? PLATFORMS).map((target) => {
    if (!isPlatform(target)) throw new Error(`unknown target ${target}; one of ${PLATFORMS.join(", ")}`)
    return target
  })
  const options = { version: values.version ?? packageJson.version, channel: values.channel }
  for (const outfile of await Promise.all(targets.map((target) => build(target, options)))) console.log(outfile)
}
