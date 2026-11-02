import type { Driver } from "./driver.ts"
import type { Root } from "./env.ts"
import type { Script } from "./mock.ts"

export type Scenario = {
  name: string
  script: Script
  // Added to the seeded project.
  files?: Record<string, string | Uint8Array>
  // Written into the isolated agent folder, such as an extension of the user's.
  agent?: Record<string, string>
  // Extra arguments after `pi --mode rpc`.
  args?: string[]
  steps(d: Driver): Promise<void>
  // Live only, after the run: checks the isolated root, such as a file the run had pi write.
  verify?(root: Root): Promise<void>
}
