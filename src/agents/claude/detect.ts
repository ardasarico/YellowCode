import type { Detection } from "../../agent/agent.ts"
import { log } from "../../log/log.ts"
import { hostEnv } from "../../source/claude-cli.ts"
import { spawnLimited } from "../../spawn.ts"

const VERSION_TIMEOUT_MS = 5000

// "2.1.305 (Claude Code)" gives "2.1.305".
function parseVersion(output: string): string | null {
  return /^(\d+\.\d+\.\d+\S*)/.exec(output.trim())?.[1] ?? null
}

// Asks the claude sessions start with for its version; nothing else runs.
export async function detect(): Promise<Detection> {
  const binary = Bun.which("claude")
  if (!binary) return { installed: false }
  const result = await spawnLimited([binary, "--version"], { timeoutMs: VERSION_TIMEOUT_MS, env: hostEnv() }).catch(
    () => null,
  )
  const version = result?.code === 0 ? parseVersion(result.stdout) : null
  if (!version) {
    log.warn("claude --version gave no version", binary)
    return { installed: false }
  }
  return { installed: true, version, blocked: null, signedIn: null }
}
