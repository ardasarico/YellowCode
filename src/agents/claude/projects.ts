import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { projectKey } from "../../project-key.ts"

export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
export const CLAUDE_PROJECTS = join(CLAUDE_HOME, "projects")

// The path with links resolved, as claude records it; the path itself when it cannot be resolved.
export function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function projectFolder(root: string, cwd: string): string {
  return join(root, projectKey(realPath(cwd)))
}
