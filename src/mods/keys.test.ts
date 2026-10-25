import { expect, test } from "bun:test"
import { matches, parseKey } from "./keys.ts"

const key = (name: string, ctrl = false) => ({ name, ctrl, shift: false, meta: false })

test("a binding matches only its own key and modifiers", () => {
  const toggle = parseKey("ctrl+`")
  const tab = parseKey("ctrl+1")
  if (!toggle || !tab) throw new Error("bindings did not parse")
  expect(matches(toggle, key("`", true))).toBe(true)
  // A terminal without the kitty keyboard protocol sends ctrl+` as NUL, read as ctrl+space.
  expect(matches(toggle, key("space", true))).toBe(true)
  expect(matches(tab, key("1", true))).toBe(true)
  expect(matches(tab, key("1"))).toBe(false)
  expect(parseKey("hyper+x")).toBeNull()
})
