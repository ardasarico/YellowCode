import { expect, test } from "bun:test"
import { parseAdd } from "./cli.ts"

const problem = (args: string[]) => {
  const parsed = parseAdd(args)
  return typeof parsed === "object" && "problem" in parsed ? parsed.problem : null
}

test("add writes variable references, never a literal secret", () => {
  expect(parseAdd(["gh", "-e", "GITHUB_TOKEN", "-e", "B=${OTHER}", "--", "npx", "-y", "server"])).toEqual({
    name: "gh",
    project: false,
    entry: {
      type: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", B: "${OTHER}" },
    },
  })
  expect(parseAdd(["--transport", "http", "docs", "https://x", "-H", "Authorization: Bearer ${TOKEN}"])).toEqual({
    name: "docs",
    project: false,
    entry: { type: "http", url: "https://x", headers: { Authorization: "Bearer ${TOKEN}" } },
  })
  expect(problem(["gh", "-e", "GITHUB_TOKEN=ghp_secret", "--", "npx"])).not.toContain("ghp_secret")
  expect(problem(["gh", "-e", "GITHUB_TOKEN=ghp_secret", "--", "npx"])).toContain("-e GITHUB_TOKEN")
  expect(problem(["docs", "--url", "https://x", "-H", "Authorization: Bearer abc"])).not.toContain("abc")
  expect(problem(["my.server", "--", "npx"])).toContain("1 to 32")
})
