// The npm packages and the Homebrew formula of a release, written from its built binaries and tarballs.
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Platform, Release } from "../src/update/channels.ts"
import { DIST, PLATFORMS } from "./build.ts"
import { thirdPartyLicenses } from "./licenses.ts"

const GITHUB = "ardasarico/YellowCode"
const LICENSE = join(import.meta.dir, "..", "LICENSE")
const DESCRIPTION = "Terminal UI for coding agents"
const LICENSES = "THIRD_PARTY_LICENSES.txt"
const COMMON = {
  description: DESCRIPTION,
  license: "GPL-3.0-only",
  author: "Arda Sarı",
  homepage: `https://github.com/${GITHUB}`,
  repository: { type: "git", url: `git+https://github.com/${GITHUB}.git` },
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
for binary in "$root/node_modules/yellowcode-$platform/bin/yellowcode" "$root/../yellowcode-$platform/bin/yellowcode"; do
  [ -x "$binary" ] && exec "$binary" "$@"
done
echo "YellowCode: yellowcode-$platform is missing; reinstall with optional dependencies allowed" >&2
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

// One folder per package under dist/npm/, ready for npm pack or npm publish. The binaries are dist/yellowcode-<platform>.
export function writeNpmPackages(version: string): string[] {
  const root = join(DIST, "npm")
  rmSync(root, { recursive: true, force: true })
  const folders = PLATFORMS.map((platform) => {
    const folder = join(root, `yellowcode-${platform}`)
    const manifest = {
      name: `yellowcode-${platform}`,
      version,
      ...COMMON,
      description: `${DESCRIPTION}: the ${platform} binary of the yellowcode package`,
      os: [OS_CPU[platform].os],
      cpu: [OS_CPU[platform].cpu],
      files: ["bin/yellowcode", "LICENSE", LICENSES],
    }
    writePackage(folder, manifest, { from: join(DIST, `yellowcode-${platform}`) })
    writeFileSync(join(folder, LICENSES), thirdPartyLicenses(join(DIST, ".stage", platform)))
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
      files: ["bin/yellowcode", "LICENSE"],
      optionalDependencies: Object.fromEntries(PLATFORMS.map((platform) => [`yellowcode-${platform}`, version])),
    },
    { text: SHIM },
  )
  return [...folders, main]
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
