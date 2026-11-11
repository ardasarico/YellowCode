import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { parseJson } from "../json.ts"
import { log } from "../log/log.ts"
import type { Channel, Platform, Release } from "./channels.ts"
import { homePath, yellowcodeHome } from "../paths.ts"
import { FORMULA, manualCommand, type Method } from "./method.ts"

export type UpdateState = { version: string; status: "ready" | "failed"; command: string }
// What an install needs from a release.
export type Target = Pick<Release, "version" | "assets">

const State = z.object({ version: z.string(), status: z.enum(["ready", "failed"]), command: z.string() })
const stateFile = () => homePath("update-state.json")

export function readState(): UpdateState | null {
  let text: string
  try {
    text = readFileSync(stateFile(), "utf8")
  } catch {
    return null
  }
  const json = parseJson(text)
  return json.ok ? (State.safeParse(json.value).data ?? null) : null
}

function writeState(state: UpdateState | null): void {
  try {
    if (!state) return rmSync(stateFile(), { force: true })
    mkdirSync(yellowcodeHome(), { recursive: true })
    writeFileSync(`${stateFile()}.tmp`, JSON.stringify(state))
    renameSync(`${stateFile()}.tmp`, stateFile())
  } catch (error) {
    log.warn("cannot save the update state", error)
  }
}

// What a start shows: nothing once the running version has caught up with the saved one.
export function currentState(running: string): UpdateState | null {
  const state = readState()
  if (state && Bun.semver.order(state.version, running) !== 1) {
    writeState(null)
    return null
  }
  return state
}

// After going back to an older version, the one left behind and everything up to it are not installed again; updates
// resume with a newer one.
const holdFile = () => homePath("update-hold.json")
const Hold = z.object({ version: z.string() })

export function heldVersion(): string | null {
  let text: string
  try {
    text = readFileSync(holdFile(), "utf8")
  } catch {
    return null
  }
  const json = parseJson(text)
  return json.ok ? (Hold.safeParse(json.value).data?.version ?? null) : null
}

export function holdBelow(version: string | null): void {
  try {
    if (!version) return rmSync(holdFile(), { force: true })
    mkdirSync(yellowcodeHome(), { recursive: true })
    writeFileSync(holdFile(), JSON.stringify({ version }))
  } catch (error) {
    log.warn("cannot save the update hold", error)
  }
}

// One update at a time on a machine, however many YellowCode windows are open. A lock older than the longest update is
// left over from a crash.
const LOCK_STALE = 15 * 60 * 1000

export function lock(): (() => void) | null {
  const folder = homePath("update.lock")
  mkdirSync(yellowcodeHome(), { recursive: true })
  try {
    if (Date.now() - statSync(folder).mtimeMs > LOCK_STALE) rmSync(folder, { recursive: true, force: true })
  } catch {
    // No lock yet.
  }
  try {
    mkdirSync(folder)
  } catch {
    return null
  }
  return () => rmSync(folder, { recursive: true, force: true })
}

export function currentPlatform(): Platform {
  const cpu = process.arch === "arm64" ? "arm64" : "x64"
  return process.platform === "darwin" ? `darwin-${cpu}` : `linux-${cpu}`
}

export type ScriptPaths = { home: string; binDir: string; running: string; platform: Platform }

// The versions are installed beside the running one (<home>/versions/<version>/yellowcode), wherever that home is.
function scriptPaths(): ScriptPaths {
  const running = realpathSync(process.execPath)
  return {
    home: dirname(dirname(dirname(running))),
    binDir: join(homedir(), ".local", "bin"),
    running,
    platform: currentPlatform(),
  }
}

function pointLauncher(binary: string, binDir: string): void {
  mkdirSync(binDir, { recursive: true })
  const link = join(binDir, `.yellowcode-${process.pid}`)
  rmSync(link, { force: true })
  symlinkSync(binary, link)
  renameSync(link, join(binDir, "yellowcode"))
}

// Points the launcher at a version that is still on disk; false when it is not there.
export function useInstalled(version: string, paths: ScriptPaths = scriptPaths()): boolean {
  const binary = join(paths.home, "versions", version, "yellowcode")
  if (!existsSync(binary)) return false
  pointLauncher(binary, paths.binDir)
  return true
}

// Unpacks the release next to the installed versions and moves the launcher link to it in one rename. The running
// version and the new one stay; older ones go.
export async function installScript(release: Target, paths: ScriptPaths = scriptPaths()): Promise<void> {
  const versions = join(paths.home, "versions")
  const temp = join(versions, `.tmp-${release.version}-${process.pid}`)
  const asset = release.assets[paths.platform]
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  try {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${asset.url}`)
    const archive = new Uint8Array(await response.arrayBuffer())
    const sha256 = createHash("sha256").update(archive).digest("hex")
    if (sha256 !== asset.sha256) throw new Error(`${basename(asset.url)} does not match its checksum`)
    writeFileSync(join(temp, "release.tar.gz"), archive)
    const tar = Bun.spawnSync(["tar", "-xzf", "release.tar.gz"], { cwd: temp, stdout: "ignore", stderr: "pipe" })
    if (tar.exitCode !== 0) throw new Error(`cannot unpack: ${tar.stderr.toString().trim()}`)
    rmSync(join(temp, "release.tar.gz"))
    if (!existsSync(join(temp, "yellowcode"))) throw new Error("the archive holds no yellowcode binary")
    chmodSync(join(temp, "yellowcode"), 0o755)
    const target = join(versions, release.version)
    rmSync(target, { recursive: true, force: true })
    renameSync(temp, target)
    pointLauncher(join(target, "yellowcode"), paths.binDir)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
  const keep = new Set([release.version, basename(dirname(paths.running))])
  for (const name of readdirSync(versions)) {
    if (!keep.has(name) && !name.startsWith(".")) rmSync(join(versions, name), { recursive: true, force: true })
  }
}

function packageCommand(method: Method, version: string): string[] {
  if (method === "npm") return ["npm", "i", "-g", `yellowcode@${version}`]
  if (method === "bun") return ["bun", "add", "-g", `yellowcode@${version}`]
  if (method === "pnpm") return ["pnpm", "add", "-g", `yellowcode@${version}`]
  return ["brew", "upgrade", FORMULA]
}

export async function installPackage(method: Method, version: string): Promise<void> {
  const command = packageCommand(method, version)
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 10 * 60 * 1000)
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  clearTimeout(timer)
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`)
}

// Installs the release with the tool YellowCode came from; the new version runs from the next start.
export async function applyUpdate(release: Target, method: Method, channel: Channel): Promise<UpdateState | null> {
  if (method === "none") return null
  const unlock = lock()
  if (!unlock) return null
  const command = manualCommand(method, channel)
  let state: UpdateState
  try {
    if (method === "script") await installScript(release)
    else await installPackage(method, release.version)
    state = { version: release.version, status: "ready", command }
    log.info(`update: ${release.version} installed with ${method}`)
  } catch (error) {
    state = { version: release.version, status: "failed", command }
    log.warn(`update to ${release.version} failed`, error)
  } finally {
    unlock()
  }
  writeState(state)
  return state
}
