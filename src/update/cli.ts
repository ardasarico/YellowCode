import { appVersion } from "../build-info.ts"
import { loadSettings } from "../session/settings-file.ts"
import { applyUpdate, holdBelow, installPackage, lock, type Target, useInstalled } from "./apply.ts"
import type { Channel, Platform } from "./channels.ts"
import { fetchChannels, pickUpdate } from "./check.ts"
import { defaultChannel, INSTALL_SCRIPT, installMethod, manualCommand, type Method } from "./method.ts"
import { channelFor } from "./updater.ts"
import { accent, bold, dim, done, live, problem, say, title } from "../cli-style.ts"

export const UPDATE_USAGE = "       yellowcode update [<version>]"
const DOWNLOADS = "https://github.com/ardasarico/YellowCode/releases/download"

// Installs the release under a line that shows the download, or that something is running when a package manager
// does the work.
async function install(release: Target, method: Method, channel: Channel) {
  const line = live()
  if (method !== "script") line.spin(`Installing with ${method}`)
  try {
    return await applyUpdate(release, method, channel, line.bar)
  } finally {
    line.clear()
  }
}

function fail(line: string, more?: string): number {
  problem(line)
  if (more) say(more)
  say()
  return 1
}

// A release named by its version: the checksums of its files come from its SHA256SUMS.
async function releaseOf(version: string) {
  const base = `${process.env["YELLOWCODE_DOWNLOADS"] ?? DOWNLOADS}/v${version}`
  const response = await fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
  if (!response?.ok) return null
  const sums = new Map(
    (await response.text())
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .flatMap(([sha256, name]) => (sha256 && name ? [[name, sha256] as const] : [])),
  )
  const asset = (platform: Platform) => {
    const name = `yellowcode-${platform}.tar.gz`
    const sha256 = sums.get(name)
    return sha256 ? { url: `${base}/${name}`, sha256 } : null
  }
  const [darwinArm, darwinX64, linuxX64, linuxArm] = [
    asset("darwin-arm64"),
    asset("darwin-x64"),
    asset("linux-x64"),
    asset("linux-arm64"),
  ]
  if (!darwinArm || !darwinX64 || !linuxX64 || !linuxArm) return null
  return {
    version,
    assets: { "darwin-arm64": darwinArm, "darwin-x64": darwinX64, "linux-x64": linuxX64, "linux-arm64": linuxArm },
  }
}

async function switchTo(version: string): Promise<number> {
  const method = installMethod()
  if (method === "brew") {
    return fail(
      `Homebrew installs the newest stable only. To run ${version}, run brew uninstall yellowcode, then:`,
      accent(`curl -fsSL ${INSTALL_SCRIPT} | bash -s ${version}`),
    )
  }
  const unlock = lock()
  if (!unlock) return fail("Another YellowCode is updating right now; try again in a minute.")
  title(`${dim(`${appVersion} →`)} ${bold(version)}`)
  try {
    if (method === "script" && !useInstalled(version)) {
      const release = await releaseOf(version)
      if (!release) return fail(`There is no release ${version}.`)
      // applyUpdate takes the lock itself.
      unlock()
      const state = await install(release, method, "stable")
      if (state?.status !== "ready") return fail(`Couldn't install ${version}.`)
    } else if (method !== "script") {
      const line = live()
      line.spin(`Installing with ${method}`)
      await installPackage(method, version).finally(line.clear)
    }
  } catch (error) {
    return fail(`Couldn't install ${version}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    unlock()
  }
  if (Bun.semver.order(version, appVersion) === -1) holdBelow(appVersion)
  else holdBelow(null)
  done("Installed; it runs from the next start.")
  say()
  return 0
}

export async function runUpdateCommand(args: string[]): Promise<number> {
  if (args.length > 1 || args[0]?.startsWith("-")) {
    process.stdout.write(`Usage:\n${UPDATE_USAGE}\n`)
    return 1
  }
  say()
  const method = installMethod()
  if (method === "none") {
    return fail(
      "This YellowCode was not installed with install.sh, npm, bun, pnpm or Homebrew, so it cannot update itself.",
      `Install it with: ${accent(`curl -fsSL ${INSTALL_SCRIPT} | bash`)}`,
    )
  }
  if (args[0]) return switchTo(args[0].replace(/^v/, ""))
  const channel = channelFor(method, loadSettings(undefined, false).settings.updates ?? defaultChannel())
  const channels = await fetchChannels(channel)
  if (!channels) return fail("Couldn't reach the release list. Check the connection and try again.")
  // Asked for by name, so a hold from going back does not apply.
  const release = pickUpdate(channels, channel, appVersion)
  if (!release) {
    done(`${bold(`YellowCode ${appVersion}`)} is up to date  ${dim(channel)}`)
    say()
    return 0
  }
  title(`${dim(`${appVersion} →`)} ${bold(release.version)}  ${dim(channel)}`)
  const state = await install(release, method, channel)
  if (!state) return fail("Another YellowCode is updating right now; try again in a minute.")
  if (state.status === "failed") {
    return fail(`Couldn't update to ${release.version}.`, `Run: ${accent(manualCommand(method, channel))}`)
  }
  holdBelow(null)
  done("Updated; it runs from the next start.")
  say()
  return 0
}
