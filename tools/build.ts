// Builds one standalone binary per platform into dist/: bun run build [--target <platform>]... [--channel <channel>]
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import solid from "@opentui/solid/bun-plugin"

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
const DIST = join(REPO, "dist")
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
function stage(platform: Platform): string {
  const folder = join(DIST, ".stage", platform)
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  for (const name of SOURCES) cpSync(join(REPO, name), join(folder, name), { recursive: true })
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

export async function build(platform: Platform, channel: string): Promise<string> {
  const folder = stage(platform)
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
    define: {
      BUILD_COMMIT: JSON.stringify(run(["git", "rev-parse", "--short", "HEAD"], REPO)),
      BUILD_CHANNEL: JSON.stringify(channel),
    },
    plugins: [solid],
  })
  if (!result.success) throw new AggregateError(result.logs, `build for ${platform} failed`)
  return outfile
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { target: { type: "string", multiple: true }, channel: { type: "string", default: "stable" } },
  })
  const targets = (values.target ?? PLATFORMS).map((target) => {
    if (!isPlatform(target)) throw new Error(`unknown target ${target}; one of ${PLATFORMS.join(", ")}`)
    return target
  })
  for (const outfile of await Promise.all(targets.map((target) => build(target, values.channel)))) console.log(outfile)
}
