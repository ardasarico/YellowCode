import type { SidebarSetting } from "../session/settings-file.ts"

export type SidebarOverride = "open" | "closed" | null
export type SidebarMode = "docked" | "overlay" | "hidden"

export const MIN_CHAT_WIDTH = 60
export const SIDEBAR_MIN_WIDTH = 30

export function sidebarShown(width: number, sidebarWidth: number, override: SidebarOverride): SidebarMode {
  if (override !== "closed" && width - sidebarWidth >= MIN_CHAT_WIDTH) return "docked"
  if (override === "open") return "overlay"
  return "hidden"
}

export function overrideFor(setting: SidebarSetting): SidebarOverride {
  if (setting === "shown") return "open"
  if (setting === "hidden") return "closed"
  return null
}
