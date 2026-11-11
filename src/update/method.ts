import { existsSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { buildChannel, compiled } from "../build-info.ts"
import { parseJson } from "../json.ts"
import { homePath, yellowcodeHome } from "../paths.ts"
import type { Channel } from "./channels.ts"

export type Method = "script" | "npm" | "bun" | "pnpm" | "brew" | "none"

export const INSTALL_SCRIPT = "https://raw.githubusercontent.com/ardasarico/YellowCode/main/install.sh"
export const FORMULA = "ardasarico/tap/yellowcode"

// How this binary was installed, from where it lives; a run from source is "none" and never updates itself.
export function methodOf(binary: string, home = yellowcodeHome()): Method {
  if (/[/\\]\.yellowcode[/\\]versions[/\\]/.test(binary) || binary.startsWith(`${join(home, "versions")}/`))
    return "script"
  if (/[/\\]Cellar[/\\]yellowcode[/\\]/.test(binary)) return "brew"
  if (/[/\\]install[/\\]global[/\\]node_modules[/\\]/.test(binary)) return "bun"
  if (/[/\\]pnpm[/\\]|[/\\]\.pnpm[/\\]/.test(binary)) return "pnpm"
  if (/[/\\]node_modules[/\\]@?yellowcode[/\\]/.test(binary)) return "npm"
  return "none"
}

export function installMethod(): Method {
  if (!compiled) return "none"
  try {
    const home = yellowcodeHome()
    return methodOf(realpathSync(process.execPath), existsSync(home) ? realpathSync(home) : home)
  } catch {
    return "none"
  }
}

const InstallRecord = z.object({ channel: z.enum(["stable", "beta"]) })

// The channel updates follow when the user has not picked one: the one install.sh was asked for, else the build's.
// install.sh may have put a stable build in place for a beta install, when stable was the newer one.
export function defaultChannel(): Channel {
  if (installMethod() === "script") {
    let text = ""
    try {
      text = readFileSync(homePath("install.json"), "utf8")
    } catch {
      // No install.json: the build's channel decides.
    }
    const json = parseJson(text)
    if (json.ok && InstallRecord.safeParse(json.value).data?.channel === "beta") return "beta"
  }
  return buildChannel === "beta" ? "beta" : "stable"
}

// The command that updates YellowCode by hand, shown when an update could not be installed.
export function manualCommand(method: Method, channel: Channel): string {
  const tag = channel === "beta" ? "beta" : "latest"
  const script = `curl -fsSL ${INSTALL_SCRIPT} | bash${channel === "beta" ? " -s beta" : ""}`
  const commands: Record<Method, string> = {
    script,
    npm: `npm i -g yellowcode@${tag}`,
    bun: `bun add -g yellowcode@${tag}`,
    pnpm: `pnpm add -g yellowcode@${tag}`,
    brew: `brew upgrade ${FORMULA}`,
    none: script,
  }
  return commands[method]
}
