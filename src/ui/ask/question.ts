// Stock AskUserQuestion questions and our own ask's pages share this shape; only ours carry pictures.
export type Question = {
  question: string
  header: string
  multiSelect?: boolean
  gallery?: boolean
  options: { label: string; description?: string; image?: string }[]
}
export type QuestionInput = { questions: Question[] }

export const LETTERS = "ABCD"
