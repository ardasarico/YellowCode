import type { z } from "zod"
import { askUserQuestionInput, OWN_ASK, ownAskMatrix, ownAskPages } from "../protocol/messages.ts"
import type { Ask } from "./types.ts"

const MOST_CHOICES = 4

export function severe(ask: Ask): boolean {
  return ask.defaultToNo || ask.safetyCheck
}

const repeats = (texts: string[]) => new Set(texts).size < texts.length

const firstIssue = (error: z.ZodError) => {
  const issue = error.issues[0]
  return issue ? `${issue.path.join(".")}: ${issue.message}` : "the input does not match the schema"
}

// What our own ask breaks, in words for Claude; null when it can be shown, and for any other tool.
export function ownAskProblem(ask: Pick<Ask, "toolName" | "input">): string | null {
  if (ask.toolName !== OWN_ASK) return null
  const input: object = typeof ask.input === "object" && ask.input !== null ? ask.input : {}
  if (Object.hasOwn(input, "questions") === Object.hasOwn(input, "matrix"))
    return "give exactly one of questions or matrix"
  if (Object.hasOwn(input, "questions")) {
    const parsed = ownAskPages.safeParse(input)
    if (!parsed.success) return firstIssue(parsed.error)
    const questions = parsed.data.questions
    if (questions.length === 0) return "at least 1 question"
    if (questions.some((page) => page.options.length > MOST_CHOICES)) return "at most 4 options per question"
    if (questions.some((page) => page.options.length < 2)) return "at least 2 options per question"
    if (questions.some((page) => page.gallery && !page.options.every((option) => option.image)))
      return "every option in a gallery needs an image"
    if (repeats(questions.map((page) => page.question))) return "questions must be unique"
    return null
  }
  const parsed = ownAskMatrix.safeParse(input)
  if (!parsed.success) return firstIssue(parsed.error)
  const matrix = parsed.data.matrix
  if (matrix.scale.length > MOST_CHOICES) return "at most 4 steps in the scale"
  if (matrix.scale.length < 2) return "at least 2 steps in the scale"
  if (matrix.rows.length < 2) return "at least 2 rows"
  if (repeats(matrix.rows.map((row) => row.label))) return "row labels must be unique"
  return null
}

// `"<question>"="<answer>" notes: <note>` pairs, in stock's wording and ours; a matrix keys each pair by its row.
// The asked keys mark where each pair starts, so quotes, ". " and ", " may sit inside keys, answers and notes.
const CLOSING = /\. (?:You can now continue|Read the answers carefully)/g

export function answersInResult(
  text: string,
  keys: string[],
): { answers: Record<string, string>; notes: Record<string, string> } {
  const answers: Record<string, string> = {}
  const notes: Record<string, string> = {}
  const found = keys
    .map((key) => ({ key, from: text.indexOf(`"${key}"="`) }))
    .filter((entry) => entry.from >= 0)
    .toSorted((a, b) => a.from - b.from)
  found.forEach(({ key, from }, index) => {
    const start = from + key.length + 4
    const next = found[index + 1]
    let segment = next ? text.slice(start, next.from).replace(/, $/, "") : text.slice(start)
    if (!next) {
      const closing = [...segment.matchAll(CLOSING)].at(-1)
      segment = closing ? segment.slice(0, closing.index) : segment.replace(/\.$/, "")
    }
    const split = segment.indexOf('" notes: ')
    const answer = split >= 0 ? segment.slice(0, split) : segment.replace(/"$/, "")
    answers[key] = answer
    if (split >= 0 && split + 9 < segment.length) notes[key] = segment.slice(split + 9)
  })
  return { answers, notes }
}

export function askKeys(input: unknown): string[] {
  const matrix = ownAskMatrix.safeParse(input).data?.matrix
  if (matrix) return matrix.rows.map((row) => row.label)
  return (askUserQuestionInput.safeParse(input).data?.questions ?? []).map((page) => page.question)
}
