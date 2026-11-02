import type { ModeKind, ModeRow } from "../agent/lists.ts"

export type Permissions = "read-only" | "edits" | "inherit"

// `confirm`: even the child's narrowest mode is wider than allowed, so it runs in `mode` only on the user's yes.
export type ChildMode = { fit: "ok"; mode: ModeRow } | { fit: "confirm"; mode: ModeRow } | { fit: "none" }

const ORDER: ModeKind[] = ["readonly", "plan", "default", "edits", "auto", "bypass"]
const FREE = new Set<ModeKind>(["auto", "bypass"])
const WIDEST: Record<Permissions, ModeKind> = { "read-only": "readonly", edits: "edits", inherit: "bypass" }

// A parent mode of unknown width counts as the narrowest.
const rank = (kind: ModeKind) => Math.max(ORDER.indexOf(kind), 0)

export function childMode(parent: ModeKind, permissions: Permissions, rows: ModeRow[]): ChildMode {
  const limit = Math.min(rank(parent), rank(WIDEST[permissions]))
  const known = rows
    .filter((row) => row.available && row.group === null && ORDER.includes(row.kind))
    .toSorted((a, b) => rank(a.kind) - rank(b.kind))
  const narrowest = known[0]
  if (!narrowest) return { fit: "none" }
  const fits = known.findLast((row) => rank(row.kind) <= limit)
  if (fits) return { fit: "ok", mode: fits }
  // A free parent lends its freedom to a child that has only free modes, as pi does.
  const free = permissions === "inherit" && FREE.has(parent) && FREE.has(narrowest.kind)
  return { fit: free ? "ok" : "confirm", mode: narrowest }
}
