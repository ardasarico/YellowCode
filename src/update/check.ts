import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { z } from "zod"
import { appVersion } from "../build-info.ts"
import { parseJson } from "../json.ts"
import { log } from "../log/log.ts"
import { type Channel, CHANNELS, type Channels, parseChannels, type Release } from "./channels.ts"

const CHANNELS_URL = "https://raw.githubusercontent.com/ardasarico/YellowCode/main/release/channels.json"
export const CHECK_EVERY = 60 * 60 * 1000

export const autoUpdateOff = () => process.env["YELLOWCODE_DISABLE_AUTOUPDATE"] === "1"

// The newest release the channel offers that is newer than `current`; beta also takes stable releases, so it never
// trails stable. Never an older one, so moving from beta to stable waits for stable to catch up.
// A held version (see holdBelow) counts as the floor too.
export function pickUpdate(
  channels: Channels,
  channel: Channel,
  current = appVersion,
  held: string | null = null,
): Release | null {
  const candidates = channel === "beta" ? [channels.stable, channels.beta] : [channels.stable]
  let best: Release | null = null
  for (const release of candidates) {
    if (!release || Bun.semver.order(release.version, current) !== 1) continue
    if (held && Bun.semver.order(release.version, held) !== 1) continue
    if (!best || Bun.semver.order(release.version, best.version) === 1) best = release
  }
  return best
}

function cacheFile(): string {
  const base = process.env["XDG_CACHE_HOME"]
  return join(base && isAbsolute(base) ? base : join(homedir(), ".cache"), "yellowcode", "update.json")
}

const Cached = z.object({ checkedAt: z.number(), channel: z.enum(CHANNELS).optional(), text: z.string() })

export function lastCheck(): { checkedAt: number; channel?: Channel; channels: Channels } | null {
  let text: string
  try {
    text = readFileSync(cacheFile(), "utf8")
  } catch {
    return null
  }
  const json = parseJson(text)
  const cached = json.ok ? Cached.safeParse(json.value).data : undefined
  const parsed = cached ? parseChannels(cached.text, true) : null
  return cached && parsed?.ok
    ? { checkedAt: cached.checkedAt, channel: cached.channel, channels: parsed.channels }
    : null
}

// The channel file, or null when it cannot be fetched or read; a failed check stays quiet, only a failed install is
// shown. A private repo answers 404 here. The cache keeps the channel the check was for, so a start after a channel
// change checks again at once.
export async function fetchChannels(channel: Channel, now = Date.now()): Promise<Channels | null> {
  const url = process.env["YELLOWCODE_CHANNELS"] ?? CHANNELS_URL
  let text: string
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) {
      log.info(`update check: HTTP ${response.status}`)
      return null
    }
    text = await response.text()
  } catch (error) {
    log.info("update check failed", error)
    return null
  }
  const parsed = parseChannels(text, url.startsWith("file:"))
  if (!parsed.ok) {
    log.warn(`update check: ${parsed.problem}`)
    return null
  }
  const file = cacheFile()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify({ checkedAt: now, channel, text }))
    renameSync(`${file}.tmp`, file)
  } catch (error) {
    log.warn("cannot cache the channel file", error)
  }
  return parsed.channels
}
