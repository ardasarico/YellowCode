import { homedir } from "node:os"
import { join } from "node:path"

export function configPath(name: string): string {
  return join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "yellowcode", name)
}
