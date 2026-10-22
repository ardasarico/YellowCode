import { expect, test } from "bun:test"
import { allowTool, userMessage } from "../protocol/outgoing.ts"
import { createReplaySource } from "./replay.ts"

const header = { cliVersion: "2.1.293", scenario: "test", recordedAt: "2026-10-07T00:00:00.000Z" }
const reply = JSON.stringify({ type: "keep_alive" })

test("pauses at each recorded user message until send, and ignores early sends", async () => {
  const source = createReplaySource(
    {
      header,
      entries: [
        { t: 0, dir: "out", line: userMessage("one") },
        { t: 5, dir: "in", line: reply },
        { t: 6, dir: "out", line: userMessage("two") },
        { t: 9, dir: "in", line: reply },
      ],
    },
    "instant",
  )
  const seen: string[] = []
  const done = (async () => {
    for await (const event of source.events) seen.push(event.dir)
  })()

  await Bun.sleep(5)
  expect(source.status()).toBe("waiting")
  expect(seen).toEqual([])

  source.send("")
  await Bun.sleep(5)
  expect(seen).toEqual(["out", "in"])
  expect(source.status()).toBe("waiting")

  source.send("")
  await done
  expect(seen).toEqual(["out", "in", "out", "in"])
  expect(source.status()).toBe("finished")
})

test("pauses before a recorded permission answer until send", async () => {
  const request = JSON.stringify({
    type: "control_request",
    request_id: "r1",
    request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "toolu_1", input: {} },
  })
  const source = createReplaySource(
    {
      header,
      entries: [
        { t: 0, dir: "in", line: request },
        { t: 1, dir: "out", line: allowTool("r1", {}) },
        { t: 2, dir: "in", line: reply },
      ],
    },
    "instant",
  )
  const seen: string[] = []
  const done = (async () => {
    for await (const event of source.events) seen.push(event.dir)
  })()

  await Bun.sleep(5)
  expect(seen).toEqual(["in"])
  expect(source.status()).toBe("waiting")

  source.send("")
  await done
  expect(seen).toEqual(["in", "out", "in"])
  expect(source.status()).toBe("finished")
})

test("a sent user line replaces the recorded one, and an answer releases the recorded answer", async () => {
  const request = JSON.stringify({
    type: "control_request",
    request_id: "r1",
    request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "toolu_1", input: {} },
  })
  const recordedAnswer = allowTool("r1", {})
  const source = createReplaySource(
    {
      header,
      entries: [
        { t: 0, dir: "out", line: userMessage("recorded") },
        { t: 1, dir: "in", line: request },
        { t: 2, dir: "out", line: recordedAnswer },
        { t: 3, dir: "in", line: reply },
      ],
    },
    "instant",
  )
  const seen: string[] = []
  const done = (async () => {
    for await (const event of source.events) seen.push(event.line)
  })()

  await Bun.sleep(5)
  source.send(userMessage("mine"))
  await Bun.sleep(5)
  expect(seen).toEqual([userMessage("mine"), request])

  source.send(allowTool("r1", { command: "ls" }))
  await done
  expect(seen).toEqual([userMessage("mine"), request, recordedAnswer, reply])
})

test("send during a pending timed pause does not skip ahead", async () => {
  const source = createReplaySource(
    {
      header,
      entries: [
        { t: 0, dir: "out", line: userMessage("one") },
        { t: 50, dir: "in", line: reply },
        { t: 60, dir: "out", line: userMessage("two") },
      ],
    },
    1,
  )
  const seen: string[] = []
  const done = (async () => {
    for await (const event of source.events) seen.push(event.dir)
  })()

  await Bun.sleep(5)
  source.send("")
  await Bun.sleep(10)
  expect(seen).toEqual(["out"])
  expect(source.status()).toBe("playing")

  source.send("")
  await Bun.sleep(5)
  expect(seen).toEqual(["out"])
  expect(source.status()).toBe("playing")

  await Bun.sleep(80)
  expect(seen).toEqual(["out", "in"])
  expect(source.status()).toBe("waiting")

  source.send("")
  await done
  expect(seen).toEqual(["out", "in", "out"])
})

test("close between yields ends iteration promptly", async () => {
  const timed = createReplaySource(
    {
      header,
      entries: [
        { t: 0, dir: "out", line: userMessage("one") },
        { t: 1000, dir: "in", line: reply },
      ],
    },
    1,
  )
  const timedIt = timed.events[Symbol.asyncIterator]()
  const first = timedIt.next()
  await Bun.sleep(5)
  timed.send("")
  expect((await first).done).toBe(false)
  timed.close()
  const started = performance.now()
  expect((await timedIt.next()).done).toBe(true)
  expect(performance.now() - started).toBeLessThan(200)

  const gated = createReplaySource(
    {
      header,
      entries: [
        { t: 0, dir: "out", line: userMessage("one") },
        { t: 5, dir: "out", line: userMessage("two") },
      ],
    },
    1,
  )
  const gatedIt = gated.events[Symbol.asyncIterator]()
  const firstGated = gatedIt.next()
  await Bun.sleep(5)
  gated.send("")
  expect((await firstGated).done).toBe(false)
  gated.close()
  expect((await gatedIt.next()).done).toBe(true)
})
