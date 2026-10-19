import { expect, test } from "bun:test"
import { welcomeLayout, welcomeParts } from "./welcome.tsx"

test("welcomeParts steps the logo down by height and width", () => {
  expect(welcomeParts(74, 14, 0)).toEqual({ logo: "full", rows: 6, recent: false })
  expect(welcomeParts(74, 13, 0)).toEqual({ logo: "cat", rows: 3, recent: false })
  expect(welcomeParts(74, 10, 0)).toEqual({ logo: "none", rows: 0, recent: false })
  expect(welcomeParts(40, 14, 0).logo).toBe("cat")
})

test("the recent sessions outlive the logo as the terminal gets shorter", () => {
  const steps = ["full", "cat", "none"]
  let last = { logo: 0, recent: true }
  for (let height = 40; height >= 12; height--) {
    const parts = welcomeLayout(120, height, 3)
    const logo = steps.indexOf(parts.logo)
    expect(logo).toBeGreaterThanOrEqual(last.logo)
    if (!parts.recent) expect(parts.logo).toBe("none")
    if (!last.recent) expect(parts.recent).toBe(false)
    last = { logo, recent: parts.recent }
  }
  expect([welcomeLayout(120, 19, 3).logo, welcomeLayout(120, 17, 3)]).toEqual([
    "cat",
    { logo: "none", rows: 0, recent: true },
  ])
  expect(welcomeLayout(120, 14, 3).recent).toBe(false)
})
