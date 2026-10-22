import { expect, test } from "bun:test"
import { welcomeLayout } from "./welcome.tsx"

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
