// Fills a provider's catalog entry from a short-lived process of its own, when the entry is missing or was listed by
// another version. Runs on first need (the picker, the subagent tool), never at startup.
import type { AgentKind } from "../agent/agent.ts"
import type { AgentKindId } from "../agent/ids.ts"
import { log } from "../log/log.ts"
import { catalogFile, readCatalog, saveListed } from "./catalog.ts"

const PROBE_MS = 60_000

type Probed = Pick<AgentKind, "id" | "detect" | "listModels">

const probes = new Map<AgentKindId, Promise<boolean>>()

// True when the catalog holds the provider's list for the version installed now.
export function ensureCatalog(kind: Probed, cwd = process.cwd(), file = catalogFile()): Promise<boolean> {
  const running = probes.get(kind.id)
  if (running) return running
  const probe = refresh(kind, cwd, file).finally(() => probes.delete(kind.id))
  probes.set(kind.id, probe)
  return probe
}

async function refresh(kind: Probed, cwd: string, file: string): Promise<boolean> {
  if (!kind.listModels) return false
  const found = await kind.detect().catch(() => null)
  if (!found?.installed || found.blocked !== null) return false
  if (readCatalog(file).providers[kind.id]?.version === found.version) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), PROBE_MS)
  })
  try {
    const groups = await Promise.race([kind.listModels(cwd), late])
    saveListed(kind.id, found.version, groups, file)
    log.info(`${kind.id}: models listed`, {
      groups: groups.length,
      models: groups.reduce((sum, group) => sum + group.models.length, 0),
    })
    return true
  } catch (error) {
    // The error can quote the agent's output, so only its length is logged.
    log.warn(`${kind.id}: listing the models failed`, { chars: String(error).length })
    return false
  } finally {
    clearTimeout(timer)
  }
}
