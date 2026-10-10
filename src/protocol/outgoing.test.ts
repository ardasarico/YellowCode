import { expect, test } from "bun:test"
import { answerQuestions } from "./outgoing.ts"
import { parse } from "./parse.ts"

test("answerQuestions keeps the input, adds answers and notes, and puts the additional note on the last question", () => {
  const input = { questions: [{ question: "Storage?" }, { question: "Formats?" }] }
  const line = answerQuestions(
    "r1",
    input,
    { "Storage?": "Per project", "Formats?": "JSON" },
    { "Storage?": "keep it local", "Formats?": "" },
    "ship it soon",
  )

  const parsed = parse(line)
  expect(parsed.kind).toBe("message")
  if (parsed.kind !== "message" || parsed.message.type !== "control_response") throw new Error("not a response")
  expect(parsed.message.response).toEqual({
    subtype: "success",
    request_id: "r1",
    response: {
      behavior: "allow",
      updatedInput: {
        questions: input.questions,
        answers: { "Storage?": "Per project", "Formats?": "JSON" },
        annotations: {
          "Storage?": { notes: "keep it local" },
          "Formats?": { notes: "Additional note: ship it soon" },
        },
      },
    },
  })
})
