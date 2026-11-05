import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { parseJson } from "../../json.ts"

// The config file also holds account details; the schema keeps only this one field.
const Config = z.object({ claudeInChromeDefaultEnabled: z.boolean().optional() })

// An interactive claude turns Claude in Chrome on when the user chose it with /chrome; under -p it needs the flag.
export function chromeArgs(): string[] {
  const file = join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json")
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const json = parseJson(text)
  if (!json.ok) return []
  const config = Config.safeParse(json.value)
  return config.success && config.data.claudeInChromeDefaultEnabled === true ? ["--chrome"] : []
}
