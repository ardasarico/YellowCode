import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import { SIDEBAR_MIN_WIDTH } from "./layout.ts"

const DEFAULT_SIDEBAR_WIDTH = 40
const State = z.object({ sidebarWidth: z.number().int().min(SIDEBAR_MIN_WIDTH) })

function statePath(): string {
  const config = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config")
  return join(config, "yellowcode", "state.json")
}

export function loadSidebarWidth(): number {
  let text: string
  try {
    text = readFileSync(statePath(), "utf8")
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
  const json = parseJson(text)
  const state = json.ok ? State.safeParse(json.value) : null
  return state?.success ? state.data.sidebarWidth : DEFAULT_SIDEBAR_WIDTH
}

export function saveSidebarWidth(width: number): void {
  const path = statePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ sidebarWidth: width })}\n`)
  } catch (error) {
    log.warn("cannot save the sidebar width", error)
  }
}
