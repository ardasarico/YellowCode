import { appVersion } from "../build-info.ts"
import { loadSettings } from "../session/settings-file.ts"
import { applyUpdate, holdBelow, installPackage, lock, useInstalled } from "./apply.ts"
import type { Platform } from "./channels.ts"
import { fetchChannels, pickUpdate } from "./check.ts"
import { defaultChannel, INSTALL_SCRIPT, installMethod, manualCommand } from "./method.ts"
import { channelFor } from "./updater.ts"

export const UPDATE_USAGE = "       yellowcode update [<version>]"
const DOWNLOADS = "https://github.com/ardasarico/YellowCode/releases/download"

const say = (text: string) => process.stdout.write(`${text}\n`)

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
    say(`Homebrew installs the newest stable only. To run ${version}, run brew uninstall yellowcode, then:`)
    say(`curl -fsSL ${INSTALL_SCRIPT} | bash -s ${version}`)
    return 1
  }
  const unlock = lock()
  if (!unlock) {
    say("Another YellowCode is updating right now; try again in a minute.")
    return 1
  }
  try {
    if (method === "script" && !useInstalled(version)) {
      const release = await releaseOf(version)
      if (!release) {
        say(`There is no release ${version}.`)
        return 1
      }
      // applyUpdate takes the lock itself.
      unlock()
      const state = await applyUpdate(release, method, "stable")
      if (state?.status !== "ready") {
        say(`Couldn't install ${version}.`)
        return 1
      }
    } else if (method !== "script") {
      await installPackage(method, version)
    }
  } catch (error) {
    say(`Couldn't install ${version}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    unlock()
  }
  if (Bun.semver.order(version, appVersion) === -1) holdBelow(appVersion)
  else holdBelow(null)
  say(`YellowCode ${version} runs from the next start.`)
  return 0
}

export async function runUpdateCommand(args: string[]): Promise<number> {
  if (args.length > 1 || args[0]?.startsWith("-")) {
    say(`Usage:\n${UPDATE_USAGE}`)
    return 1
  }
  const method = installMethod()
  if (method === "none") {
    say("This YellowCode was not installed with install.sh, npm, bun, pnpm or Homebrew, so it cannot update itself.")
    say(`Install it with: curl -fsSL ${INSTALL_SCRIPT} | bash`)
    return 1
  }
  if (args[0]) return switchTo(args[0].replace(/^v/, ""))
  const channel = channelFor(method, loadSettings(undefined, false).settings.updates ?? defaultChannel())
  const channels = await fetchChannels()
  if (!channels) {
    say("Couldn't reach the release list. Check the connection and try again.")
    return 1
  }
  // Asked for by name, so a hold from going back does not apply.
  const release = pickUpdate(channels, channel, appVersion)
  if (!release) {
    say(`YellowCode ${appVersion} is up to date (${channel}).`)
    return 0
  }
  say(`Updating to ${release.version}…`)
  const state = await applyUpdate(release, method, channel)
  if (!state) {
    say("Another YellowCode is updating right now; try again in a minute.")
    return 1
  }
  if (state.status === "failed") {
    say(`Couldn't update to ${release.version}. Run: ${manualCommand(method, channel)}`)
    return 1
  }
  holdBelow(null)
  say(`Updated to ${release.version}; it runs from the next start.`)
  return 0
}
