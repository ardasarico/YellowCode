import { expect, test } from "bun:test"
import { proseShortcuts, shortcutKeys } from "./shortcut.ts"

test("shortcuts split into keys and commands do not", () => {
  expect(shortcutKeys("Ctrl+Shift+Z")).toEqual(["Ctrl", "Shift", "Z"])
  expect(shortcutKeys("Esc")).toEqual(["Esc"])
  expect(shortcutKeys("npm run")).toBeNull()
})

test("prose shortcuts need a modifier", () => {
  expect(proseShortcuts("Undo with Ctrl+Z, then Enter.").map((part) => part.keys)).toEqual([null, ["Ctrl", "Z"], null])
  expect(proseShortcuts("C++ and a+b").every((part) => part.keys === null)).toBe(true)
})
