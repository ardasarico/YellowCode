import { expect, test } from "bun:test"
import { sidebarShown } from "./layout.ts"

test("sidebarShown docks beside a 60-column chat and only overlays below that", () => {
  expect(sidebarShown(140, 40, null, false)).toEqual({ mode: "docked", width: 40 })
  expect(sidebarShown(140, 40, "closed", false).mode).toBe("hidden")
  expect(sidebarShown(95, 40, null, false)).toEqual({ mode: "docked", width: 35 })
  expect(sidebarShown(89, 40, "open", false).mode).toBe("hidden")
  expect(sidebarShown(80, 40, "open", true)).toEqual({ mode: "overlay", width: 40 })
})
