import type { Task } from "./types.ts"

// Agents spawned below `root` at any depth.
export function nestedAgents(tasks: Record<string, Task>, root: string | null): number {
  if (!root) return 0
  return Object.values(tasks).filter((task) => {
    if (task.type !== "local_agent") return false
    const seen = new Set<string>()
    for (let parent = task.parentId; parent && !seen.has(parent); parent = tasks[parent]?.parentId ?? null) {
      if (parent === root) return true
      seen.add(parent)
    }
    return false
  }).length
}
