import type { z } from "zod"
import type { QuestionPage, Questions } from "../../agent/ask.ts"
import { askUserQuestionInput, OWN_ASK, ownAskMatrix, ownAskPages } from "../../protocol/messages.ts"
import type { Ask } from "../../session/types.ts"

const MOST_CHOICES = 4

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

// The schemas are loose, so a field only the other tool declares may hold anything.
const textOf = (value: unknown) => (typeof value === "string" ? value : null)

type Page = {
  question: string
  header: string
  multiSelect?: boolean
  gallery?: boolean
  options: { label: string; description?: string; preview?: string; image?: string }[]
}

// Each page is filed under its question; only our own ask's pages carry pictures.
function pagesOf(pages: Page[]): Questions {
  return {
    pages: pages.map((page): QuestionPage => ({
      key: page.question,
      header: page.header,
      question: page.question,
      multi: page.multiSelect ?? false,
      gallery: page.gallery === true,
      custom: true,
      options: page.options.map((choice) => ({
        label: choice.label,
        description: choice.description ?? null,
        preview: textOf(choice.preview),
        image: textOf(choice.image),
      })),
    })),
  }
}

// AskUserQuestion's pages, or our own ask's pages or matrix; null for input the views cannot show.
export function questionsOf(name: string, input: unknown): Questions | null {
  if (name === "AskUserQuestion") {
    const stock = askUserQuestionInput.safeParse(input).data
    return stock ? pagesOf(stock.questions) : null
  }
  if (name !== OWN_ASK) return null
  const pages = ownAskPages.safeParse(input).data
  if (pages) return pagesOf(pages.questions)
  const matrix = ownAskMatrix.safeParse(input).data?.matrix
  if (!matrix) return null
  const rows = matrix.rows.map((row) => row.label)
  return { matrix: { header: matrix.header, question: matrix.question, rows, scale: matrix.scale } }
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
