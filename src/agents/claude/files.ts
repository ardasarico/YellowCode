import { suggestFiles } from "../../input/files.ts"
import { log } from "../../log/log.ts"
import { fileSuggestions } from "../../protocol/messages.ts"
import { fileSuggestionsRequest } from "../../protocol/outgoing.ts"
import type { Requests } from "../../source/requests.ts"

const FILES_TIMEOUT_MS = 5000
const FILE_ROWS = 15

export async function claudeFiles(requests: Requests, query: string): Promise<string[]> {
  try {
    const reply = await requests.send((id) => fileSuggestionsRequest(id, query), FILES_TIMEOUT_MS)
    // A folder query lists the folder itself first; picking it would only reopen the same list.
    const paths = (fileSuggestions.safeParse(reply).data?.suggestions ?? [])
      .map(({ path }) => path)
      .filter((path) => path !== query)
    if (paths.length > 0) return paths.slice(0, FILE_ROWS)
    // claude answers nothing while its index is cold, and it finds a new file only seconds after it appears; git
    // has both (and nothing either when nothing matches).
    log.debug("file suggestions from git: claude found nothing")
    return await suggestFiles(query)
  } catch (error) {
    log.debug("file suggestions failed", error instanceof Error ? error.message : error)
    return suggestFiles(query)
  }
}
