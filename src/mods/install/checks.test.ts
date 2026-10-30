import { expect, test } from "bun:test"
import { apiMatches, revokedCommit, revokedListing } from "./checks.ts"
import type { ModList } from "./list.ts"

const sha = "a".repeat(40)
const list: ModList = {
  mods: [],
  revoked: [
    { id: "one", versions: ["1.0.0"], shas: [sha], reason: "bad build" },
    { id: "two", versions: "all", reason: "gone" },
  ],
}

test("revokedCommit refuses a listed sha of that mod only", () => {
  expect(revokedCommit(list, "one", sha)).toBe("bad build")
  expect(revokedCommit(list, "one", "b".repeat(40))).toBeNull()
  expect(revokedCommit(list, "other", sha)).toBeNull()
  expect(revokedCommit(list, "two", sha)).toBeNull()
})

test("revokedListing refuses revoked versions, or all of them", () => {
  expect(revokedListing(list, "one", "1.0.0")).toBe("bad build")
  expect(revokedListing(list, "one", "1.1.0")).toBeNull()
  expect(revokedListing(list, "one", undefined)).toBeNull()
  expect(revokedListing(list, "two", "9.9.9")).toBe("gone")
  expect(revokedListing(list, "two", undefined)).toBe("gone")
  expect(revokedListing(list, "other", "1.0.0")).toBeNull()
})

test("apiMatches accepts ranges that include this api version", () => {
  expect(apiMatches("^0.2.0")).toBe(true)
  expect(apiMatches(">=0.1.0")).toBe(true)
  expect(apiMatches("^9.0.0")).toBe(false)
})
