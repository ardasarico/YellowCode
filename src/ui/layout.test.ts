import { expect, test } from "bun:test"
import { sidebarShown } from "./layout.ts"

test("sidebarShown narrows to dock beside a 60-column chat and squeezes the chat only when opened", () => {
  expect(sidebarShown(140, 40, null)).toEqual({ mode: "docked", width: 40 })
  expect(sidebarShown(140, 40, "closed").mode).toBe("hidden")
  expect(sidebarShown(95, 40, null)).toEqual({ mode: "docked", width: 35 })
  expect(sidebarShown(89, 40, null).mode).toBe("hidden")
  expect(sidebarShown(89, 40, "open")).toEqual({ mode: "docked", width: 30 })
  expect(sidebarShown(40, 40, "open")).toEqual({ mode: "docked", width: 20 })
})
