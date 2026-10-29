import type { AgentDriver } from "./agent-driver.ts"
import type { Driver } from "./driver.ts"
import type { Root } from "./env.ts"
import type { Script } from "./mock.ts"

type Base = {
  name: string
  script: Script
  // TOML appended to the isolated config.toml; a function gets the root, for paths in it.
  config?: string | ((root: Root) => string)
  // Top-level keys of config.toml, such as the approval policy.
  top?: string
  // Codex's own retries of a request and of a stream that broke; none by default.
  retries?: { request: number; stream: number }
  // Added to the seeded project.
  files?: Record<string, string | Uint8Array>
  // Written into the isolated CODEX_HOME, such as a skill of the user's.
  home?: Record<string, string>
  // Live only, after the run: checks the isolated root, such as a file the run had Codex write.
  verify?(root: Root): Promise<void>
}

// Raw steps drive app-server over JSON-RPC, as the harness did before the adapter existed; the others drive the
// adapter's intents, on as many app-servers as the adapter spawns.
export type RawScenario = Base & { steps(d: Driver): Promise<void> }
export type AgentScenario = Base & { run(a: AgentDriver): Promise<void> }
export type Scenario = RawScenario | AgentScenario

export const isRaw = (scenario: Scenario): scenario is RawScenario => "steps" in scenario
