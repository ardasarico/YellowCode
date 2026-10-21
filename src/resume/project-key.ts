import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MAX_KEY_LENGTH = 200

export const CLAUDE_PROJECTS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")

export function projectKey(path: string): string {
  const key = path.replace(/[^A-Za-z0-9]/g, "-")
  if (key.length <= MAX_KEY_LENGTH) return key
  let hash = 0
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0
  return `${key.slice(0, MAX_KEY_LENGTH)}-${Math.abs(hash).toString(36)}`
}

export function projectFolder(root: string, cwd: string): string {
  let real = cwd
  try {
    real = realpathSync(cwd)
  } catch {}
  return join(root, projectKey(real))
}
