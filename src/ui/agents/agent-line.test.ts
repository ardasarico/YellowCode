import { expect, test } from "bun:test"
import { shortError } from "./agent-line.tsx"

test("a failed agent's error shortens to its API status or its first sentence", () => {
  expect(
    shortError(
      "Agent terminated early due to an API error: API Error: 500 Internal Server Error. This is a server-side issue.",
    ),
  ).toBe("API 500")
  expect(shortError("Agent terminated early due to a hook: Blocked by policy. Ask an admin.")).toBe(
    "Blocked by policy.",
  )
})
