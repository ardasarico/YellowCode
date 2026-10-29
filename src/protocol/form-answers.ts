// Form answers as text, as `answered` keeps them.
export function formAnswers(answer: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answer).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : JSON.stringify(value),
    ]),
  )
}
