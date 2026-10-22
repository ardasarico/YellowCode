import { expect, test } from "bun:test"
import { projectKey } from "./project-key.ts"

test("a long path is cut to 200 characters plus the hash the CLI appends", () => {
  const path = `/private/tmp/yellowcode-key/${"a_b.c".repeat(50)}`
  expect(path.length).toBe(278)
  expect(projectKey(path)).toBe(
    "-private-tmp-yellowcode-key-a-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca-b-ca--jq1ckp",
  )
})
