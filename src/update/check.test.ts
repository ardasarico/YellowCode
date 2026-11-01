import { expect, test } from "bun:test"
import type { Channels, Release } from "./channels.ts"
import { autoUpdateOff, pickUpdate } from "./check.ts"

const asset = { url: "https://example.com/x.tar.gz", sha256: "a".repeat(64) }
const release = (version: string): Release => ({
  version,
  commit: "b".repeat(40),
  bundle: "c".repeat(64),
  assets: { "darwin-arm64": asset, "darwin-x64": asset, "linux-x64": asset, "linux-arm64": asset },
})
const channels = (stable: string | null, beta: string | null): Channels => ({
  stable: stable ? release(stable) : null,
  beta: beta ? release(beta) : null,
})
const pick = (all: Channels, channel: "stable" | "beta", current: string) =>
  pickUpdate(all, channel, current)?.version ?? null

test("an update is the newest version the channel offers, never an older one", () => {
  expect(pick(channels("0.2.0", "0.3.0-beta.2"), "beta", "0.3.0-beta.1")).toBe("0.3.0-beta.2")
  expect(pick(channels("0.2.0", "0.3.0-beta.2"), "stable", "0.2.0")).toBeNull()
  // Stable 0.3.0 is newer than every 0.3.0 beta, so beta users get it too.
  expect(pick(channels("0.3.0", "0.3.0-beta.2"), "beta", "0.3.0-beta.2")).toBe("0.3.0")
  // A user who moves from beta back to stable keeps the newer beta until stable passes it.
  expect(pick(channels("0.2.0", "0.3.0-beta.2"), "stable", "0.3.0-beta.2")).toBeNull()
  expect(pick(channels("0.3.0", null), "stable", "0.3.0-beta.2")).toBe("0.3.0")
  expect(pick(channels("0.3.0", "0.3.0-beta.10"), "beta", "0.3.0-beta.9")).toBe("0.3.0")
  expect(pick(channels(null, "0.3.0-beta.10"), "beta", "0.3.0-beta.9")).toBe("0.3.0-beta.10")
})

test("the env variable turns updates off", () => {
  process.env["YELLOWCODE_DISABLE_AUTOUPDATE"] = "1"
  expect(autoUpdateOff()).toBe(true)
  delete process.env["YELLOWCODE_DISABLE_AUTOUPDATE"]
  expect(autoUpdateOff()).toBe(false)
})

test("after going back, the version left behind is not installed again", () => {
  expect(pickUpdate(channels("0.3.0", null), "stable", "0.2.1", "0.3.0")).toBeNull()
  expect(pickUpdate(channels("0.3.1", null), "stable", "0.2.1", "0.3.0")?.version).toBe("0.3.1")
})
