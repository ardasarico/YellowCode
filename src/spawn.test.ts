import { expect, test } from "bun:test"
import { spawnLimited } from "./spawn.ts"

test("a command that outlives its timeout resolves null", async () => {
  const started = performance.now()
  expect(await spawnLimited(["sleep", "5"], { timeoutMs: 100 })).toBeNull()
  expect(performance.now() - started).toBeLessThan(3000)
})

test("a finished command returns its output", async () => {
  expect(await spawnLimited(["echo", "hi"], { timeoutMs: 2000 })).toEqual({ code: 0, stdout: "hi\n", stderr: "" })
})
