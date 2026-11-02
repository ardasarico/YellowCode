import { OWN_COMMANDS } from "../../input/commands.ts"
import type { InputProvider } from "../../input/provider.ts"
import type { SessionStore } from "../../session/session.ts"
import { listedProvider } from "../opencode/provider.ts"

// YellowCode's dialogs of lists pi does not fill; pi's own command of the same name takes the row.
const YIELDING = new Set(["mcp", "skills", "plugins"])

export function piProvider(store: () => SessionStore, files: (query: string) => Promise<string[]>): InputProvider {
  const base = listedProvider(store, files)
  return {
    ...base,
    commands() {
      const own = (store().lists().commands ?? []).filter((row) => YIELDING.has(row.name))
      const names = new Set(own.map((row) => row.name))
      const rows = base.commands().filter((row) => !(names.has(row.name) && OWN_COMMANDS.includes(row)))
      return [
        ...own.map(({ name, description, argumentHint, aliases, builtin }) => ({
          name,
          description,
          argumentHint,
          aliases,
          builtin,
        })),
        ...rows,
      ]
    },
  }
}
