import type { Detection } from "../agent/agent.ts"
import type { AgentKindId } from "../agent/ids.ts"
import { loadSettings, saveSettings, type StoredSettings, usedProviders } from "../session/settings-file.ts"
import { askProviders, type ProviderRow } from "./providers-prompt.ts"

export type KnownProvider = { id: AgentKindId; name: string; detect: () => Promise<Detection> }

const isTerminal = () => process.stdin.isTTY && process.stdout.isTTY

function exit(message: string, code = 1): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

// The installed providers, and the added ones that are not installed (so they can be kept or removed).
async function providerRows(known: KnownProvider[], added: AgentKindId[]): Promise<ProviderRow[]> {
  const found = await Promise.all(
    known.map(async (agent) => ({
      agent,
      detection: await agent.detect().catch((): Detection => ({ installed: false })),
    })),
  )
  return found.flatMap(({ agent: { id, name }, detection }): ProviderRow[] => {
    if (detection.installed) return [{ id, name, version: detection.version, blocked: detection.blocked }]
    return added.includes(id) ? [{ id, name, version: "not installed", blocked: null }] : []
  })
}

// The providers a live start uses. The first start asks; a file from before providers adds the ones it used without
// asking. Undefined when nothing that could be added is installed, so the start fails as it would without one.
export async function settleProviders(
  settings: StoredSettings,
  known: KnownProvider[],
): Promise<AgentKindId[] | undefined> {
  if (settings.providers !== undefined) return settings.providers
  const used = usedProviders(
    settings,
    known.map(({ id }) => id),
  )
  if (used.length > 0) {
    saveSettings({ ...settings, providers: used })
    return used
  }
  if (!isTerminal()) exit("No provider added. Run yellowcode in a terminal to pick one.")
  const rows = await providerRows(known, [])
  if (!rows.some((row) => row.blocked === null)) return undefined
  const picked = await askProviders(rows, [])
  if (picked === null) process.exit(130)
  saveSettings({ ...settings, providers: picked })
  return picked
}

// `yellowcode providers`: the same list, with the added ones checked.
export async function runProvidersCommand(known: KnownProvider[]): Promise<number> {
  if (!isTerminal()) exit("yellowcode providers needs a terminal; stdin and stdout must be a TTY")
  const { settings, problem } = loadSettings(undefined, false)
  if (problem !== null) exit(problem)
  const added =
    settings.providers ??
    usedProviders(
      settings,
      known.map(({ id }) => id),
    )
  const rows = await providerRows(known, added)
  if (!rows.some((row) => row.blocked === null)) exit("No provider is installed.")
  const picked = await askProviders(rows, added)
  if (picked === null) return 130
  return saveSettings({ ...settings, providers: picked }) ? 0 : 1
}
