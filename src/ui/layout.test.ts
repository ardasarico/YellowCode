import { expect, test } from "bun:test"
import { sidebarShown } from "./layout.ts"

test("sidebarShown docks when the chat keeps 60 columns and overlays only when opened", () => {
  expect(sidebarShown(140, 40, null)).toBe("docked")
  expect(sidebarShown(140, 40, "closed")).toBe("hidden")
  expect(sidebarShown(99, 40, null)).toBe("hidden")
  expect(sidebarShown(99, 40, "open")).toBe("overlay")
})
