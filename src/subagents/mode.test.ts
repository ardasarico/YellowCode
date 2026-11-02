import { expect, test } from "bun:test"
import type { ModeKind, ModeRow } from "../agent/lists.ts"
import { childMode, type Permissions } from "./mode.ts"

const row = (kind: ModeKind, available = true, id: string = kind): ModeRow => ({
  id,
  label: id,
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
// build can run with every edit and shell command asked.
const OPENCODE = [row("auto", true, "build"), row("plan")]

// One cell per parent, in PARENTS order; "?" marks a mode that needs the user's yes.
const EXPECTED: [string, ModeRow[], Record<Permissions, string>, string | null][] = [
  [
    "codex",
    CODEX,
    {
      inherit: "readonly plan plan plan auto bypass readonly",
      edits: "readonly plan plan plan plan plan readonly",
      "read-only": "readonly readonly readonly readonly readonly readonly readonly",
    },
    null,
  ],
  [
    "claude",
    CLAUDE,
    {
      inherit: "?plan plan default default auto bypass ?plan",
      edits: "?plan plan default default default default ?plan",
      "read-only": "?plan ?plan ?plan ?plan ?plan ?plan ?plan",
    },
    null,
  ],
  [
    "pi",
    PI,
    {
      inherit: "?bypass ?bypass ?bypass ?bypass bypass bypass ?bypass",
      edits: "?bypass ?bypass ?bypass ?bypass ?bypass ?bypass ?bypass",
      "read-only": "?bypass ?bypass ?bypass ?bypass ?bypass ?bypass ?bypass",
    },
    null,
  ],
  [
    "opencode",
    OPENCODE,
    {
      inherit: "?plan plan build+ask build+ask build build ?plan",
      edits: "?plan plan build+ask build+ask build+ask build+ask ?plan",
      "read-only": "?plan ?plan ?plan ?plan ?plan ?plan ?plan",
    },
    "build",
  ],
]

test.each(EXPECTED)("a %s child never runs wider than its parent allows", (_, rows, expected, asking) => {
  for (const permissions of PERMISSIONS) {
    const got = PARENTS.map((parent) => {
      const result = childMode(parent, permissions, rows, asking)
      if (result.fit === "none") return "none"
      const shown = result.mode.id === result.mode.kind ? result.mode.kind : result.mode.id
      return (result.fit === "confirm" ? "?" : "") + shown + (result.asks ? "+ask" : "")
    })
    expect(got.join(" ")).toBe(expected[permissions])
  }
})

test("a child with no mode of known width cannot start", () => {
  expect(childMode("bypass", "inherit", [row("other"), row("auto", false)])).toEqual({ fit: "none" })
})
