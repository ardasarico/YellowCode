import { homedir } from "node:os"
import { join } from "node:path"
import type { Detection } from "../../agent/agent.ts"
import { log } from "../../log/log.ts"
import { spawnLimited } from "../../spawn.ts"

const VERSION_TIMEOUT_MS = 5000

// The installer puts opencode in ~/.opencode/bin, which is not always on PATH.
export function findBinary(path = process.env["PATH"] ?? "", home = homedir()): string | null {
  return Bun.which("opencode", { PATH: path }) ?? Bun.which("opencode", { PATH: join(home, ".opencode", "bin") })
}

// "opencode v2.2.0", "v2.2.0" and "2.2.0" all give "2.2.0".
function parseVersion(output: string): string | null {
  const line = output.trim().split("\n")[0]?.trim() ?? ""
  return /^(?:opencode\s+)?v?(\d+\.\d+\.\d+\S*)$/.exec(line)?.[1] ?? null
}

// Asks the binary for its version only; no service is started.
export async function detect(path?: string, home?: string): Promise<Detection> {
  const binary = findBinary(path, home)
  if (!binary) return { installed: false }
  const result = await spawnLimited([binary, "--version"], { timeoutMs: VERSION_TIMEOUT_MS }).catch(() => null)
  const version = result?.code === 0 ? parseVersion(result.stdout) : null
  if (!version) {
    log.warn("opencode --version gave no version", binary)
    return { installed: false }
  }
  const blocked = Number(version.split(".")[0]) < 2 ? "needs opencode 2" : null
  return { installed: true, version, blocked, signedIn: null }
}
