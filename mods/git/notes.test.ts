import { expect, test } from "bun:test"
import { diffLines, type Line, notesMessage, withNote } from "./notes.ts"

const diff = `diff --git a/src/login.ts b/src/login.ts
index 1111111..2222222 100644
--- a/src/login.ts
+++ b/src/login.ts
@@ -10,4 +10,4 @@ export function login() {
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 return a
\\ No newline at end of file
@@ -40,2 +41,2 @@
-old
+new
 last
diff --git a/src/moved.ts b/src/moved.ts
new file mode 100644
--- /dev/null
+++ b/src/moved.ts
@@ -0,0 +1 @@
+moved
`

test("diff lines carry the new file's number, removed ones the old file's", () => {
  expect(diffLines(diff).map((row) => (row.kind === "gap" ? "gap" : `${row.kind} ${row.number} ${row.text}`))).toEqual([
    "ctx 10 const a = 1",
    "del 11 const b = 2",
    "add 11 const b = 3",
    "add 12 const c = 4",
    "ctx 13 return a",
    "gap",
    "del 40 old",
    "add 41 new",
    "ctx 42 last",
    "gap",
    "add 1 moved",
  ])
})

test("the message names file and line, and an empty note deletes", () => {
  const added: Line = { kind: "add", number: 42, text: "x" }
  const removed: Line = { kind: "del", number: 17, text: "y" }
  let notes = withNote({}, "src/login.ts", added, "show an error when the email is empty")
  notes = withNote(notes, "src/reset.ts", removed, " the link never expires ")
  notes = withNote(notes, "src/login.ts", { kind: "ctx", number: 3, text: "z" }, "drop me")
  notes = withNote(notes, "src/login.ts", { kind: "ctx", number: 3, text: "z" }, "")
  notes = withNote(notes, "src/reset.ts", { kind: "add", number: 2, text: "w" }, "why", "src/old.ts")
  notes = withNote(notes, "src/reset.ts", { kind: "del", number: 5, text: "v" }, "keep this", "src/old.ts")
  expect(notesMessage(notes)).toBe(
    "Notes on your changes:\n- src/login.ts:42 show an error when the email is empty\n- src/reset.ts:2 why\n- src/old.ts:5 (removed line) keep this\n- src/reset.ts:17 (removed line) the link never expires",
  )
})
