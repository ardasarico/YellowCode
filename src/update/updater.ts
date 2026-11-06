import { createSignal } from "solid-js"
import { appVersion } from "../build-info.ts"
import { log } from "../log/log.ts"
import { applyUpdate, currentState, heldVersion, readState, type UpdateState } from "./apply.ts"
import type { Channel } from "./channels.ts"
import { autoUpdateOff, CHECK_EVERY, fetchChannels, lastCheck, pickUpdate } from "./check.ts"
import { installMethod, type Method } from "./method.ts"

const [updateNotice, setUpdateNotice] = createSignal<UpdateState | null>(null)
export { updateNotice }

export const updateText = (state: UpdateState) =>
  state.status === "failed"
    ? `Couldn't update to ${state.version} · ${state.command}`
    : `${state.version} ready · restart to use it`

// Homebrew has the stable formula only.
export const channelFor = (method: Method, picked: Channel): Channel => (method === "brew" ? "stable" : picked)

export async function updateOnce(method: Method, channel: Channel): Promise<UpdateState | null> {
  const channels = await fetchChannels(channel)
  const release = channels ? pickUpdate(channels, channel, undefined, heldVersion()) : null
  if (channels) log.info(`update check (${channel}): ${release ? `${release.version} found` : "up to date"}`)
  if (!release) return null
  const saved = readState()
  if (saved?.version === release.version && saved.status === "ready") return saved
  return applyUpdate(release, method, channel)
}

let checkNow: () => void = () => {}

// Checks again at once when the user picks another channel, so a new beta shows up without waiting for the next check.
export const channelChanged = () => checkNow()

// Checks in the background, at most once in CHECK_EVERY across starts unless the channel changed since, and installs
// what it finds; a failure shows until an update gets through or the user updates by hand.
export function startUpdater(channel: () => Channel): void {
  const method = installMethod()
  if (method === "none" || autoUpdateOff()) return
  setUpdateNotice(currentState(appVersion))
  let running = false
  let again = false
  const run = async () => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      const state = await updateOnce(method, channelFor(method, channel()))
      if (state) setUpdateNotice(state)
    } catch (error) {
      log.warn("update failed", error)
    } finally {
      running = false
    }
    if (again) {
      again = false
      void run()
    }
  }
  checkNow = () => void run()
  const last = lastCheck()
  const due = last?.channel === channelFor(method, channel()) ? last.checkedAt + CHECK_EVERY : 0
  setTimeout(() => void run(), Math.max(0, due - Date.now())).unref()
  setInterval(() => void run(), CHECK_EVERY).unref()
}
