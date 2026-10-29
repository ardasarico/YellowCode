// Our own ask's answer text, as every agent that hosts the ask gives it to the model.
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
