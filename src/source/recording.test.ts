import { expect, test } from "bun:test"
import { parseRecording, recordedCommands, serializeRecording } from "./recording.ts"

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

const lines = (...messages: object[]) =>
  messages.map((message) => ({ t: 0, dir: "in" as const, line: JSON.stringify(message) }))

test("recordedCommands drops terminal-only, help and internal names", () => {
  const initialize = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "1",
      response: {
        commands: ["compact", "color", "help", "__internal"].map((name) => ({
          name,
          description: "",
          argumentHint: "",
        })),
      },
    },
  }
  const init = {
    type: "system",
    subtype: "init",
    session_id: "s",
    model: "m",
    permissionMode: "default",
    cwd: "/",
    claude_code_version: "2.1.296",
    tools: [],
    mcp_servers: [],
    skills: [],
    slash_commands: ["compact", "color", "help", "__internal"],
    terminal_slash_commands: ["color"],
  }
  expect(recordedCommands({ header, entries: lines(initialize, init) }).map(({ name }) => name)).toEqual(["compact"])
  expect(recordedCommands({ header, entries: lines(init) }).map(({ name }) => name)).toEqual(["compact"])
})
