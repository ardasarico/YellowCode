import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { configPath } from "../config-path.ts"
import { log } from "../log/log.ts"
import { parseJson } from "../protocol/json.ts"
import { SIDEBAR_MIN_WIDTH } from "./layout.ts"

const DEFAULT_SIDEBAR_WIDTH = 40
const State = z.object({ sidebarWidth: z.number().int().min(SIDEBAR_MIN_WIDTH) })

export function loadSidebarWidth(): number {
  let text: string
  try {
    text = readFileSync(configPath("state.json"), "utf8")
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
  const json = parseJson(text)
  const state = json.ok ? State.safeParse(json.value) : null
  return state?.success ? state.data.sidebarWidth : DEFAULT_SIDEBAR_WIDTH
}

export function saveSidebarWidth(width: number): void {
  const path = configPath("state.json")
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ sidebarWidth: width })}\n`)
  } catch (error) {
    log.warn("cannot save the sidebar width", error)
  }
}
