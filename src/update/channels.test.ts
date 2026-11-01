import { expect, test } from "bun:test"
import { parseChannels } from "./channels.ts"

const asset = { url: "https://example.com/yellowcode.tar.gz", sha256: "a".repeat(64) }
const release = {
  version: "0.3.0-beta.1",
  commit: "b".repeat(40),
  bundle: "c".repeat(64),
  assets: { "darwin-arm64": asset, "darwin-x64": asset, "linux-x64": asset, "linux-arm64": asset },
}
const problem = (beta: unknown) => {
  const result = parseChannels(JSON.stringify({ stable: null, beta }))
  return result.ok ? null : result.problem
}

test("a channel file is read, or says what is wrong with it", () => {
  expect(problem(release)).toBeNull()
  expect(problem(null)).toBeNull()
  expect(problem({ ...release, version: "0.3.0-rc.1" })).toBe(
    "channels.json: beta.version: must be like 1.2.3 or 1.2.3-beta.4",
  )
  const { "linux-arm64": _missing, ...three } = release.assets
  expect(problem({ ...release, assets: three })).toStartWith("channels.json: beta.assets.linux-arm64:")
  const short = { ...asset, sha256: "abc" }
  expect(problem({ ...release, assets: { ...release.assets, "darwin-x64": short } })).toBe(
    "channels.json: beta.assets.darwin-x64.sha256: must be 64 hex characters",
  )
})
