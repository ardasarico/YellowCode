// Codex's model catalog as /model groups. The catalog names no provider: it is the session's provider's group, and
// each other provider in config.toml gets the same models in a group that applies in a new session.
/* oxlint-disable no-await-in-loop -- each page names the next */
import type { EffortRow, ModelGroup, ModelRow } from "../../agent/lists.ts"
import { providerNames } from "./allow.ts"
import type { Rpc } from "./transport.ts"
import { model as modelSchema, type CodexModel } from "./wire/settings.ts"
import { page, resultOf } from "./wire/thread.ts"

const MAX_PAGES = 10

// Codex lists the levels lowest first.
const effortsOf = (model: CodexModel): EffortRow[] =>
  model.supportedReasoningEfforts.map((effort) => ({
    id: effort.reasoningEffort,
    label: effort.reasoningEffort,
    ...(effort.reasoningEffort === model.defaultReasoningEffort ? { note: "default" } : {}),
  }))

const rowOf = (provider: string, model: CodexModel): ModelRow => ({
  ref: { provider, id: model.id },
  label: model.displayName,
  note: model.description,
  resolves: null,
  efforts: effortsOf(model),
  images: model.inputModalities.includes("image"),
  window: null,
})

// Hidden models are left out, as Codex's own picker leaves them.
export async function readCatalog(rpc: Rpc): Promise<CodexModel[]> {
  const found: CodexModel[] = []
  let cursor: string | null = null
  for (let count = 0; count < MAX_PAGES; count++) {
    const listed: unknown = await rpc.request("model/list", cursor === null ? {} : { cursor })
    const reply = resultOf(listed, page, "model/list")
    if (reply.kind !== "ok") break
    for (const row of reply.value.data) {
      const parsed = modelSchema.safeParse(row)
      if (parsed.success && !parsed.data.hidden) found.push(parsed.data)
    }
    cursor = reply.value.nextCursor
    if (cursor === null) break
  }
  return found
}

export async function readModels(
  rpc: Rpc,
  cwd: string,
  provider: string,
): Promise<{ groups: ModelGroup[]; catalog: CodexModel[] }> {
  const catalog = await readCatalog(rpc)
  const names = await providerNames(rpc, cwd)
  const groupOf = (id: string, applies: ModelGroup["applies"]): ModelGroup => ({
    provider: { id, name: names.get(id) ?? id },
    applies,
    models: catalog.map((model) => rowOf(id, model)),
  })
  const others = [...names.keys()].filter((id) => id !== provider)
  return { groups: [groupOf(provider, "now"), ...others.map((id) => groupOf(id, "new-session"))], catalog }
}
