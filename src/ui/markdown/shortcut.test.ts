import { expect, test } from "bun:test"
import { shortcutKeys } from "./shortcut.ts"

test("shortcuts split into keys and commands do not", () => {
  expect(shortcutKeys("Ctrl+Shift+Z")).toEqual(["Ctrl", "Shift", "Z"])
  expect(shortcutKeys("Esc")).toEqual(["Esc"])
  expect(shortcutKeys("npm run")).toBeNull()
})
