import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

type Env = Record<string, string | undefined>

// The one folder YellowCode writes to. YELLOWCODE_HOME relocates it; a value that is not an absolute path is ignored.
export function yellowcodeHome(env: Env = process.env, home = homedir()): string {
  const set = env["YELLOWCODE_HOME"]
  return set && isAbsolute(set) ? set : join(home, ".yellowcode")
}

export const homePath = (...names: string[]): string => join(yellowcodeHome(), ...names)

// Files that can be deleted at any time; they are fetched again.
export const cachePath = (name: string): string => homePath("cache", name)

export const logDir = (): string => process.env["YELLOWCODE_LOG_DIR"] ?? homePath("logs")
export const snapshotsRoot = (): string => process.env["YELLOWCODE_SNAPSHOT_DIR"] || homePath("snapshots")

// A unix socket's path holds about 100 bytes (104 on macOS, 108 on Linux), and a session's is <folder>/<pid>.sock.
const SOCKET_FOLDER_BYTES = 84

// Where running sessions find each other. Under a home too long for a socket path, a short folder named after it.
export function sessionsDir(env: Env = process.env, home = homedir()): string {
  const set = env["YELLOWCODE_SESSIONS_DIR"]
  if (set) return set
  const root = yellowcodeHome(env, home)
  const folder = join(root, "sessions")
  if (Buffer.byteLength(folder) <= SOCKET_FOLDER_BYTES) return folder
  const key = createHash("sha256").update(root).digest("hex").slice(0, 12)
  return `/tmp/yellowcode-${process.getuid?.() ?? 0}-${key}`
}

// Where YellowCode kept its files before they all went under one folder, as that code resolved them.
export function oldFolders(env: Env = process.env, home = homedir()): { config: string; data: string; cache: string } {
  const absolute = (name: string) => {
    const value = env[name]
    return value && isAbsolute(value) ? value : null
  }
  return {
    config: join(absolute("XDG_CONFIG_HOME") ?? join(home, ".config"), "yellowcode"),
    data: join(env["XDG_DATA_HOME"] || join(home, ".local", "share"), "yellowcode"),
    cache: join(absolute("XDG_CACHE_HOME") ?? join(home, ".cache"), "yellowcode"),
  }
}
