import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installScript, type ScriptPaths } from "./apply.ts"
import type { Release } from "./channels.ts"

function setup() {
  const root = mkdtempSync(join(tmpdir(), "yellowcode-update-"))
  const home = join(root, ".yellowcode")
  const binDir = join(root, "bin")
  for (const version of ["0.1.0", "0.2.0"]) {
    mkdirSync(join(home, "versions", version), { recursive: true })
    writeFileSync(join(home, "versions", version, "yellowcode"), version)
  }
  mkdirSync(binDir)
  symlinkSync(join(home, "versions", "0.2.0", "yellowcode"), join(binDir, "yellowcode"))
  const source = join(root, "source")
  mkdirSync(source)
  writeFileSync(join(source, "yellowcode"), "0.3.0")
  Bun.spawnSync(["tar", "-czf", join(root, "release.tar.gz"), "-C", source, "yellowcode"])
  const sha256 = createHash("sha256")
    .update(readFileSync(join(root, "release.tar.gz")))
    .digest("hex")
  const release = (url: string, sum = sha256): Release => {
    const asset = { url, sha256: sum }
    return {
      version: "0.3.0",
      commit: "b".repeat(40),
      bundle: "c".repeat(64),
      assets: { "darwin-arm64": asset, "darwin-x64": asset, "linux-x64": asset, "linux-arm64": asset },
    }
  }
  const paths: ScriptPaths = {
    home,
    binDir,
    running: join(home, "versions", "0.2.0", "yellowcode"),
    platform: "darwin-arm64",
  }
  return { root, home, binDir, paths, release, url: `file://${join(root, "release.tar.gz")}` }
}

test("a script install moves the launcher to the new version and keeps the running one", async () => {
  const { home, binDir, paths, release, url } = setup()
  await installScript(release(url), paths)
  expect(readlinkSync(join(binDir, "yellowcode"))).toBe(join(home, "versions", "0.3.0", "yellowcode"))
  expect(readFileSync(join(binDir, "yellowcode"), "utf8")).toBe("0.3.0")
  expect(readdirSync(join(home, "versions")).toSorted()).toEqual(["0.2.0", "0.3.0"])
})

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => String(error),
  )

test("a bad download leaves the installed version in place", async () => {
  const { root, home, binDir, paths, release, url } = setup()
  const before = readlinkSync(join(binDir, "yellowcode"))
  expect(await failure(installScript(release(url, "0".repeat(64)), paths))).toContain("does not match its checksum")
  expect(await failure(installScript(release(`file://${join(root, "missing.tar.gz")}`), paths))).not.toBeNull()
  expect(readlinkSync(join(binDir, "yellowcode"))).toBe(before)
  expect(readdirSync(join(home, "versions")).toSorted()).toEqual(["0.1.0", "0.2.0"])
})
