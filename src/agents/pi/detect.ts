import type { Detection } from "../../agent/agent.ts"
import { log } from "../../log/log.ts"
import { spawnLimited } from "../../spawn.ts"

const VERSION_TIMEOUT_MS = 5000

export function findBinary(path = process.env["PATH"] ?? ""): string | null {
  return Bun.which("pi", { PATH: path })
}

// "1.4.0", "pi 1.4.0" and "v1.4.0" all give "1.4.0"; suffixes such as "-beta.2" stay.
export function parseVersion(output: string): string | null {
  const line = output.trim().split("\n")[0]?.trim() ?? ""
  return /^(?:pi\s+)?v?(\d+\.\d+\.\d+\S*)$/.exec(line)?.[1] ?? null
}

// Asks the binary for its version only; no RPC process is started.
export async function detect(path?: string): Promise<Detection> {
  const binary = findBinary(path)
  if (!binary) return { installed: false }
  const result = await spawnLimited([binary, "--version"], { timeoutMs: VERSION_TIMEOUT_MS }).catch(() => null)
  const version = result?.code === 0 ? parseVersion(result.stdout) : null
  if (!version) {
    log.warn("pi --version gave no version", binary)
    return { installed: false }
  }
  return { installed: true, version, blocked: null, signedIn: null }
}
