import { expect, test } from "bun:test"
import type { ModeKind, ModeRow } from "../agent/lists.ts"
import { childMode, type Permissions } from "./mode.ts"

const row = (kind: ModeKind, available = true): ModeRow => ({
  id: kind,
  label: kind,
  description: "",
  kind,
  cycle: true,
  available,
  group: null,
})

const PARENTS: ModeKind[] = ["readonly", "plan", "default", "edits", "auto", "bypass", "other"]
const PERMISSIONS: Permissions[] = ["inherit", "edits", "read-only"]

// No default or edits row, and a mode of unknown width that is never picked.
const CODEX = [row("readonly"), row("auto"), row("plan"), row("bypass"), row("other")]
// No read-only row, and an edits row the session cannot switch to.
const CLAUDE = [row("auto"), row("default"), row("edits", false), row("plan"), row("bypass"), row("other")]
const PI = [row("bypass")]

// One cell per parent, in PARENTS order; "?" marks a mode that needs the user's yes.
const EXPECTED: [string, ModeRow[], Record<Permissions, string>][] = [
  [
    "codex",
    CODEX,
    {
      inherit: "readonly plan plan plan auto bypass readonly",
      edits: "readonly plan plan plan plan plan readonly",
      "read-only": "readonly readonly readonly readonly readonly readonly readonly",
    },
  ],
  [
    "claude",
    CLAUDE,
    {
      inherit: "?plan plan default default auto bypass ?plan",
      edits: "?plan plan default default default default ?plan",
      "read-only": "?plan ?plan ?plan ?plan ?plan ?plan ?plan",
    },
  ],
  [
    "pi",
    PI,
    {
      inherit: "?bypass ?bypass ?bypass ?bypass bypass bypass ?bypass",
      edits: "?bypass ?bypass ?bypass ?bypass ?bypass ?bypass ?bypass",
      "read-only": "?bypass ?bypass ?bypass ?bypass ?bypass ?bypass ?bypass",
    },
  ],
]

test.each(EXPECTED)("a %s child never runs wider than its parent allows", (_, rows, expected) => {
  for (const permissions of PERMISSIONS) {
    const got = PARENTS.map((parent) => {
      const result = childMode(parent, permissions, rows)
      if (result.fit === "none") return "none"
      return (result.fit === "confirm" ? "?" : "") + result.mode.kind
    })
    expect(got.join(" ")).toBe(expected[permissions])
  }
})

test("a child with no mode of known width cannot start", () => {
  expect(childMode("bypass", "inherit", [row("other"), row("auto", false)])).toEqual({ fit: "none" })
})
