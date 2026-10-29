import type { AgentDriver } from "./agent-driver.ts"
import type { Driver } from "./driver.ts"
import type { Root } from "./env.ts"
import type { Script } from "./mock.ts"

type Base = {
  name: string
  script: Script
  // Merged into the isolated opencode.json; a function gets the mock's baseURL, for a provider of its own, and the root.
  config?: Record<string, unknown> | ((mock: string, root: Root) => Record<string, unknown>)
  // Added to the seeded project, and to the root's bin folder, which the service has first on its PATH.
  files?: Record<string, string>
  bin?: Record<string, string>
  // The seed is committed only after the service has opened the project, so opencode keeps the folder's project
  // ("global") while sessions get the commit's id.
  lateCommit?: boolean
  // Live only, after the run: checks the isolated root, such as a file the run had opencode write.
  verify?(root: Root): Promise<void>
}

// Raw steps drive the service over HTTP, as the harness did before the adapter existed; the others drive the
// adapter's intents.
export type RawScenario = Base & { steps(d: Driver): Promise<void> }
export type AgentScenario = Base & { run(a: AgentDriver): Promise<void> }
export type Scenario = RawScenario | AgentScenario

export const isRaw = (scenario: Scenario): scenario is RawScenario => "steps" in scenario
