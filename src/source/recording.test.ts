import { expect, test } from "bun:test"
import { parseRecording, serializeRecording } from "./recording.ts"

const header = { cliVersion: "2.1.293", scenario: "chat", recordedAt: "2026-10-07T00:00:00.000Z" }
const entry = { t: 0, dir: "out" as const, line: "{}" }

test("round-trips and tolerates CRLF and blank lines", () => {
  const text = serializeRecording({ header, entries: [entry] }).replaceAll("\n", "\r\n") + "\r\n\r\n"
  expect(parseRecording(text)).toEqual({ header, entries: [entry] })
})

test("names the line of a malformed entry", () => {
  const text = [JSON.stringify(header), JSON.stringify(entry), '{"t":"soon"}'].join("\n")
  expect(() => parseRecording(text)).toThrow("line 3")
})
