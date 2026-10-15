import type { SidebarSetting } from "../session/settings-file.ts"

export type SidebarOverride = "open" | "closed" | null
export type SidebarMode = "docked" | "overlay" | "hidden"

export const MIN_CHAT_WIDTH = 60
export const SIDEBAR_MIN_WIDTH = 30

// The sidebar takes at most half the terminal. It narrows down to its minimum to dock beside a 60-column chat before
// it overlays the chat.
export function sidebarShown(
  width: number,
  preferred: number,
  override: SidebarOverride,
): { mode: SidebarMode; width: number } {
  const capped = Math.min(preferred, Math.max(SIDEBAR_MIN_WIDTH, Math.floor(width / 2)))
  const room = width - MIN_CHAT_WIDTH
  if (override !== "closed" && room >= SIDEBAR_MIN_WIDTH) return { mode: "docked", width: Math.min(capped, room) }
  return { mode: override === "open" ? "overlay" : "hidden", width: capped }
}

export function overrideFor(setting: SidebarSetting): SidebarOverride {
  if (setting === "shown") return "open"
  if (setting === "hidden") return "closed"
  return null
}
