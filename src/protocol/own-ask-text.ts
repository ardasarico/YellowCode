// Our own ask's answer text, as every agent that hosts the ask gives it to the model.
import type { Answers } from "../agent/ask.ts"
import { ownAskMatrix, ownAskPages } from "./messages.ts"

// The model sees notes only under a question's own key, so an additional note joins the last question's notes.
export function withAdditionalNote(
  notes: Record<string, string>,
  last: string | undefined,
  additionalNote: string,
): Record<string, string> {
  if (additionalNote === "" || last === undefined) return notes
  const extra = `Additional note: ${additionalNote}`
  return { ...notes, [last]: notes[last] ? `${notes[last]}\n${extra}` : extra }
}

// The keys our own ask's answers go under: a matrix's row labels, else each page's question.
export function ownAskKeys(input: unknown): string[] {
  const matrix = ownAskMatrix.safeParse(input).data?.matrix
  if (matrix) return matrix.rows.map((row) => row.label)
  return (ownAskPages.safeParse(input).data?.questions ?? []).map((page) => page.question)
}

// The answers in the words stock AskUserQuestion gives Claude.
export function ownAskAnswerText(
  input: unknown,
  answers: Record<string, string>,
  notes: Record<string, string | undefined>,
): string {
  const pairs = ownAskKeys(input)
    .filter((key) => answers[key] !== undefined)
    .map((key) => `"${key}"="${answers[key]}"${notes[key] ? ` notes: ${notes[key]}` : ""}`)
    .join(", ")
  const matrix = ownAskMatrix.safeParse(input).data?.matrix
  const body = matrix ? `"${matrix.question}": ${pairs}` : pairs
  return `Your questions have been answered: ${body}. You can now continue with these answers in mind.`
}

// The answers as an adapter gives them for our own ask. A page's extra note joins the last question's notes.
export function ownAskAnswered(
  input: unknown,
  given: Answers,
): { said: string; answers: Record<string, string>; notes: Record<string, string> } {
  const keys = ownAskKeys(input)
  const answered = keys.filter((key) => given.values[key] !== undefined)
  const answers = Object.fromEntries(answered.map((key) => [key, given.values[key]?.join(", ") ?? ""]))
  const typed = Object.fromEntries(Object.entries(given.notes).filter(([, note]) => note !== ""))
  const last = ownAskMatrix.safeParse(input).success ? undefined : keys.at(-1)
  const notes = withAdditionalNote(typed, last, given.note.trim())
  return {
    said: ownAskAnswerText(input, answers, notes),
    answers,
    notes: Object.fromEntries(answered.flatMap((key) => (notes[key] ? [[key, notes[key]]] : []))),
  }
}
