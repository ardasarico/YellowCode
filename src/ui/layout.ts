import type { SidebarSetting } from "../session/settings-file.ts"

export type SidebarOverride = "open" | "closed" | null
export type SidebarMode = "docked" | "overlay" | "hidden"

export const MIN_CHAT_WIDTH = 60
// The chat keeps this many rows beside a mod's bottom pane; the panes keep at least these sizes, or are not shown.
export const MIN_CHAT_ROWS = 8
export const PANE_MIN_HEIGHT = 3
export const PANE_MIN_WIDTH = 20
export const SIDEBAR_MIN_WIDTH = 30
// The empty cells between content and the window or sidebar edge, the same on both sides of the chat, the prompt and
// the sidebar.
export const EDGE_GAP = 2
// One more empty cell before a docked sidebar: the terminal's own padding already widens the chat's left edge, so its
// right edge looked cramped beside the sidebar's fill.
export const SIDEBAR_GAP = 1

// The sidebar takes at most half the terminal, and at least SIDEBAR_MIN_WIDTH columns. It narrows down to its minimum
// to dock beside a 60-column chat; in a terminal narrower than that it never docks, and F3 lays it over the right side
// of the chat instead.
export function sidebarShown(
  width: number,
  preferred: number,
  override: SidebarOverride,
  overlay: boolean,
): { mode: SidebarMode; width: number } {
  const capped = Math.min(preferred, Math.max(SIDEBAR_MIN_WIDTH, Math.floor(width / 2)))
  const room = width - MIN_CHAT_WIDTH
  if (room < SIDEBAR_MIN_WIDTH) return { mode: overlay ? "overlay" : "hidden", width: capped }
  if (override === "closed") return { mode: "hidden", width: capped }
  return { mode: "docked", width: Math.min(capped, room) }
}

export function overrideFor(setting: SidebarSetting): SidebarOverride {
  if (setting === "shown") return "open"
  if (setting === "hidden") return "closed"
  return null
}
