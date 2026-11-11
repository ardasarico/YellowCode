import { mkdirSync, watch } from "node:fs"
import { log } from "../log/log.ts"
import { listMemories } from "./store.ts"
import { forgotLine, savedLine, type Tell } from "./tools.ts"

const SETTLE_MS = 200

// Tells of each change to the folder's memories, for an agent whose calls YellowCode does not see: it runs the tools
// in a process of its own. `wanted` says whether the changes of the moment are that agent's.
export function watchMemory(folder: string, wanted: () => boolean, tell: Tell): void {
  const read = () => new Map(listMemories(folder).map((memory) => [memory.name, memory]))
  let known = read()
  let timer: ReturnType<typeof setTimeout> | undefined
  const look = () => {
    const now = read()
    if (wanted()) {
      for (const [name, memory] of now) {
        const before = known.get(name)
        if (before?.modified !== memory.modified) tell(savedLine(name, before !== undefined))
      }
      for (const name of known.keys()) if (!now.has(name)) tell(forgotLine(name))
    }
    known = now
  }
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    watch(folder, () => {
      clearTimeout(timer)
      timer = setTimeout(look, SETTLE_MS)
    }).unref()
  } catch (error) {
    log.warn("memory folder not watched", error)
  }
}
