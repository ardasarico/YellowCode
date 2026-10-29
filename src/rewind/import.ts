import { existsSync, lstatSync } from "node:fs"
import { join } from "node:path"
import type { PromptId } from "../agent/ids.ts"
import type { FileBackup } from "../agent/sessions.ts"
import { log } from "../log/log.ts"
import { blobId, inRoot, writeManifest } from "./common.ts"
import type { Manifest } from "./live-rewind.ts"
import type { Write } from "./restore.ts"
import type { Change, Planted, Snapshots } from "./snapshots.ts"

// The import of one session from the agent's own backups (feature fileHistory): each prompt that has no manifest yet
// gets an imported one, from the backups of the files its calls changed. A file without a readable backup is listed as
// unknown, so a rewind keeps it.
export async function importBackups(
  snapshots: Snapshots,
  sessionId: string,
  backups: (wanted: (prompt: PromptId) => boolean) => Promise<FileBackup[]>,
): Promise<void> {
  try {
    const fresh = await backups((prompt) => !existsSync(join(snapshots.store, "prompts", `${prompt}.json`)))
    for (const prompt of fresh) {
      // oxlint-disable-next-line no-await-in-loop -- one tree per prompt, in the store's queue anyway
      writeManifest(snapshots.store, await imported(snapshots, sessionId, prompt))
    }
    if (fresh.length > 0) log.info("agent backups imported", { sessionId, prompts: fresh.length })
  } catch (error) {
    log.warn("agent backups not imported", { sessionId, error: String(error) })
  }
}

async function imported(snapshots: Snapshots, sessionId: string, prompt: FileBackup): Promise<Manifest> {
  const { root } = snapshots
  const planted: Planted[] = []
  const changes: Change[] = []
  const unknown: string[] = []
  const writes: Write[] = []
  const texts = new Map<string, string>()
  for (const file of prompt.files) {
    const path = inRoot(root, file.path)
    if (path === null || changes.some((change) => change.path === path)) continue
    if (file.change) writes.push({ path, kind: file.change })
    const copy = file.before !== null && file.before !== "missing" ? file.before.copy : null
    if (file.after !== null) texts.set(path, file.after)
    if (file.before === "missing") unknown.push(path)
    else if (copy) {
      const executable = ((lstatSync(join(root, path), { throwIfNoEntry: false })?.mode ?? 0) & 0o111) !== 0
      planted.push({ path, source: copy, mode: executable ? "100755" : "100644" })
    }
    changes.push({ path, status: file.before === null ? "A" : "M", plus: null, minus: null })
  }
  const id = `import-${prompt.prompt}`
  const before = await snapshots.plant(id, planted)
  const left: Record<string, string> = {}
  for (const [path, text] of texts) left[path] = blobId(Buffer.from(text), before.tree)
  return {
    uuid: prompt.prompt,
    sessionId,
    // Pruning counts from the import, which is when the store got these backups.
    sentAt: Date.now(),
    segments: [
      {
        kind: "imported",
        before: { id, tree: before.tree, unknown },
        beforeAt: prompt.at,
        after: null,
        changes,
        writes,
        base: null,
        outside: [],
        outsideKept: [],
        left,
      },
    ],
    latest: {},
    shells: [],
  }
}
