import type { SidebarSetting } from "../session/settings-file.ts"

export type SidebarOverride = "open" | "closed" | null
export type SidebarMode = "docked" | "hidden"

export const MIN_CHAT_WIDTH = 60
export const SIDEBAR_MIN_WIDTH = 30

// The sidebar takes at most half the terminal. It narrows down to its minimum to dock beside a 60-column chat; when
// opened in a terminal narrower than that it squeezes the chat instead of covering it.
export function sidebarShown(
  width: number,
  preferred: number,
  override: SidebarOverride,
): { mode: SidebarMode; width: number } {
  const capped = Math.min(preferred, Math.max(SIDEBAR_MIN_WIDTH, Math.floor(width / 2)))
  const room = width - MIN_CHAT_WIDTH
  if (override === "closed") return { mode: "hidden", width: capped }
  if (room >= SIDEBAR_MIN_WIDTH) return { mode: "docked", width: Math.min(capped, room) }
  if (override === "open") return { mode: "docked", width: Math.min(SIDEBAR_MIN_WIDTH, Math.floor(width / 2)) }
  return { mode: "hidden", width: capped }
}

export function overrideFor(setting: SidebarSetting): SidebarOverride {
  if (setting === "shown") return "open"
  if (setting === "hidden") return "closed"
  return null
}
