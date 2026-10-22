import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export function configPath(name: string): string {
  const base = process.env["XDG_CONFIG_HOME"]
  return join(base && isAbsolute(base) ? base : join(homedir(), ".config"), "yellowcode", name)
}
