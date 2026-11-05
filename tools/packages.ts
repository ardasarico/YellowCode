// The npm packages and the Homebrew formula of a release, written from its built binaries and tarballs.
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import packageJson from "../package.json"
import type { Platform, Release } from "../src/update/channels.ts"
import { DIST, PLATFORMS } from "./build.ts"
import { thirdPartyLicenses } from "./licenses.ts"

const GITHUB = "ardasarico/YellowCode"
const REPO = join(import.meta.dir, "..")
const LICENSE = join(REPO, "LICENSE")
const DESCRIPTION = "Terminal UI for coding agents"
const LICENSES = "THIRD_PARTY_LICENSES.txt"
const COMMON = {
  description: DESCRIPTION,
  license: "GPL-3.0-only",
  author: "Arda Sarı",
  homepage: `https://github.com/${GITHUB}`,
  repository: { type: "git", url: `git+https://github.com/${GITHUB}.git` },
  keywords: ["claude-code", "codex", "opencode", "pi", "coding-agent", "ai", "tui", "terminal", "cli"],
}

// Finds the binary of the platform package installed with this one: inside its node_modules (npm), or next to it
// (bun, pnpm, and npm when both are installed at the top level).
const SHIM = `#!/bin/sh
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
root=$(cd "$(dirname "$self")/.." && pwd -P)
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Darwin-x86_64) platform=darwin-x64 ;;
  Linux-aarch64 | Linux-arm64) platform=linux-arm64 ;;
  Linux-x86_64) platform=linux-x64 ;;
  *) echo "YellowCode has no build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
for binary in "$root/node_modules/@yellowcode/$platform/bin/yellowcode" "$root/../@yellowcode/$platform/bin/yellowcode"; do
  [ -x "$binary" ] && exec "$binary" "$@"
done
echo "YellowCode: @yellowcode/$platform is missing; reinstall with optional dependencies allowed" >&2
exit 1
`

const OS_CPU: Record<Platform, { os: string; cpu: string }> = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "linux-x64": { os: "linux", cpu: "x64" },
  "linux-arm64": { os: "linux", cpu: "arm64" },
}

function writePackage(folder: string, manifest: object, binary: { from?: string; text?: string }): void {
  mkdirSync(join(folder, "bin"), { recursive: true })
  writeFileSync(join(folder, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  cpSync(LICENSE, join(folder, "LICENSE"))
  const target = join(folder, "bin", "yellowcode")
  if (binary.from) cpSync(binary.from, target)
  else writeFileSync(target, binary.text ?? "")
  chmodSync(target, 0o755)
}

// The binaries live in packages of the yellowcode npm organization, so no one else can take their names.
const platformPackage = (platform: Platform) => `@yellowcode/${platform}`

// One folder per package under dist/npm/, ready for npm pack or npm publish. The binaries are dist/yellowcode-<platform>.
export function writeNpmPackages(version: string): string[] {
  const root = join(DIST, "npm")
  rmSync(root, { recursive: true, force: true })
  const folders = PLATFORMS.map((platform) => {
    const folder = join(root, `yellowcode-${platform}`)
    const manifest = {
      name: platformPackage(platform),
      version,
      ...COMMON,
      description: `${DESCRIPTION}: the ${platform} binary of the yellowcode package`,
      os: [OS_CPU[platform].os],
      cpu: [OS_CPU[platform].cpu],
      files: ["bin/yellowcode", "LICENSE", LICENSES, "README.md"],
    }
    writePackage(folder, manifest, { from: join(DIST, `yellowcode-${platform}`) })
    writeFileSync(join(folder, LICENSES), thirdPartyLicenses(join(DIST, ".stage", platform)))
    writeFileSync(
      join(folder, "README.md"),
      `# ${platformPackage(platform)}\n\nThe ${platform} binary of [YellowCode](https://github.com/${GITHUB}). Install \`yellowcode\` instead; it picks this package for you.\n`,
    )
    return folder
  })
  const main = join(root, "yellowcode")
  writePackage(
    main,
    {
      name: "yellowcode",
      version,
      ...COMMON,
      bin: { yellowcode: "bin/yellowcode" },
      files: ["bin/yellowcode", "LICENSE", "README.md"],
      optionalDependencies: Object.fromEntries(PLATFORMS.map((platform) => [platformPackage(platform), version])),
    },
    { text: SHIM },
  )
  writeFileSync(join(main, "README.md"), npmReadme(readFileSync(join(REPO, "README.md"), "utf8")) + packageList())
  return [...folders, main, writeTypesPackage(root, version)]
}

const npmLink = (name: string) => `- [${name}](https://www.npmjs.com/package/${name})`

// npm's Dependencies tab leaves out optional dependencies, so the README names the packages instead.
function packageList(): string {
  const platforms = PLATFORMS.map((platform) => `${npmLink(platformPackage(platform))}: the ${platform} binary`)
  return `\n## Packages\n\n${[...platforms, `${npmLink("@yellowcode/mod")}: types for writing mods`].join("\n")}\n`
}

// npm shows the README away from the repo, so its relative links and images point at GitHub instead.
export function npmReadme(readme: string): string {
  const raw = `https://raw.githubusercontent.com/${GITHUB}/main/`
  const blob = `https://github.com/${GITHUB}/blob/main/`
  const relative = String.raw`(?!https?:|#|mailto:)([^"()\s]+)`
  return readme
    .replace(new RegExp(String.raw`\b(src|srcset)="${relative}"`, "g"), `$1="${raw}$2"`)
    .replace(new RegExp(String.raw`\bhref="${relative}"`, "g"), `href="${blob}$1"`)
    .replace(new RegExp(String.raw`!\[([^\]]*)\]\(${relative}\)`, "g"), `![$1](${raw}$2)`)
    .replace(new RegExp(String.raw`(?<!!)\]\(${relative}\)`, "g"), `](${blob}$1)`)
}

const TYPES_README = `# @yellowcode/mod

The types of \`yellowcode/mod\`, the API of [YellowCode](https://github.com/${GITHUB}) mods. It holds no code: YellowCode
gives a mod the API when it loads it. See [Setting up](https://github.com/${GITHUB}/blob/main/docs/mod-api.md#setting-up).
`

// Types only, for type-checking a mod. It brings the Solid and OpenTUI versions YellowCode runs, for their JSX types.
function writeTypesPackage(root: string, version: string): string {
  const folder = join(root, "yellowcode-mod")
  mkdirSync(folder, { recursive: true })
  const manifest = {
    name: "@yellowcode/mod",
    version,
    ...COMMON,
    description: "Types of the YellowCode mod API",
    types: "index.d.ts",
    exports: { ".": { types: "./index.d.ts" } },
    files: ["index.d.ts", "LICENSE"],
    dependencies: {
      "solid-js": packageJson.dependencies["solid-js"],
      "@opentui/core": packageJson.dependencies["@opentui/core"],
      "@opentui/solid": packageJson.dependencies["@opentui/solid"],
    },
  }
  writeFileSync(join(folder, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(folder, "README.md"), TYPES_README)
  cpSync(join(REPO, "types/mod.d.ts"), join(folder, "index.d.ts"))
  cpSync(LICENSE, join(folder, "LICENSE"))
  return folder
}

export function formula(release: Release): string {
  const block = (platform: Platform) => {
    const { url, sha256 } = release.assets[platform]
    return `      url "${url}"\n      sha256 "${sha256}"`
  }
  return `class Yellowcode < Formula
  desc "${DESCRIPTION}"
  homepage "https://github.com/${GITHUB}"
  version "${release.version}"
  license "GPL-3.0-only"

  on_macos do
    on_arm do
${block("darwin-arm64")}
    end
    on_intel do
${block("darwin-x64")}
    end
  end

  on_linux do
    on_arm do
${block("linux-arm64")}
    end
    on_intel do
${block("linux-x64")}
    end
  end

  def install
    bin.install "yellowcode"
    prefix.install "LICENSE", "${LICENSES}"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/yellowcode --version")
  end
end
`
}
