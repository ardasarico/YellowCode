import { realpathSync } from "node:fs"
import { gitEnv } from "../rewind/common.ts"

function gitRoot(cwd: string): string {
  try {
    const run = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, env: gitEnv({}), stderr: "ignore" })
    return run.exitCode === 0 ? run.stdout.toString().trim() : ""
  } catch {
    return ""
  }
}

// A session's project: the root of the git repository it runs in, or its own folder.
export function projectOf(cwd: string): string {
  const folder = gitRoot(cwd) || cwd
  try {
    return realpathSync(folder)
  } catch {
    return folder
  }
}

// Two sessions share a project when either folder holds the other.
export const sameProject = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
