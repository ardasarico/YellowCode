import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRecord, writeRecord } from "./record.ts"

test("an install record round-trips and a missing one reads as null", () => {
  const mods = join(mkdtempSync(join(tmpdir(), "yellowcode-record-")), "mods")
  const record = {
    source: "github:someone/ci-status",
    sha: "a".repeat(40),
    treeHash: `sha256-${"A".repeat(43)}=`,
    version: "0.3.1",
    listed: true,
    installedAt: "2026-10-26T10:00:00.000Z",
  }
  expect(readRecord(mods, "ci-status")).toBeNull()
  writeRecord(mods, "ci-status", record)
  expect(readRecord(mods, "ci-status")).toEqual(record)
})
