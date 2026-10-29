import type { Detection } from "../../agent/agent.ts"
import { log } from "../../log/log.ts"
import { spawnLimited } from "../../spawn.ts"

const VERSION_TIMEOUT_MS = 5000

export function findBinary(path = process.env["PATH"] ?? ""): string | null {
  return Bun.which("codex", { PATH: path })
}

// "codex-cli 0.165.0", "codex 0.165.0" and "0.165.0" all give "0.165.0"; suffixes such as "-alpha.1" stay.
export function parseVersion(output: string): string | null {
  const line = output.trim().split("\n")[0]?.trim() ?? ""
  return /^(?:codex(?:-cli)?\s+)?v?(\d+\.\d+\.\d+\S*)$/.exec(line)?.[1] ?? null
}

// Asks the binary for its version only; no app-server is started. Any version is let through: app-server says
// what it can do once it runs.
export async function detect(path?: string): Promise<Detection> {
  const binary = findBinary(path)
  if (!binary) return { installed: false }
  const result = await spawnLimited([binary, "--version"], { timeoutMs: VERSION_TIMEOUT_MS }).catch(() => null)
  const version = result?.code === 0 ? parseVersion(result.stdout) : null
  if (!version) {
    log.warn("codex --version gave no version", binary)
    return { installed: false }
  }
  return { installed: true, version, blocked: null, signedIn: null }
}
