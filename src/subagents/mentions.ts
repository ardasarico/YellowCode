import type { ModelRow } from "../agent/lists.ts"
import { modelText } from "./children.ts"

type Named = Pick<ModelRow, "ref" | "label">
type Choice = { provider: { id: string }; row: Named }

// The rows a name stands for: an id or a label, with or without the inner provider.
export function rowsNamed<Row extends Named>(rows: Row[], name: string): Row[] {
  const wanted = name.trim().toLowerCase()
  const found = new Map<string, Row>()
  for (const row of rows) {
    const names = [row.ref.id, row.label, modelText(row.ref)]
    if (row.ref.provider) names.push(`${row.ref.provider}/${row.label}`)
    if (names.some((one) => one.toLowerCase() === wanted)) found.set(modelText(row.ref), row)
  }
  return [...found.values()]
}

const fullName = ({ provider, row }: Choice) => `${provider.id}/${modelText(row.ref)}`

// The rows of every added provider a name stands for; `<provider>/<model>` names one provider's row.
export function resolveName<One extends Choice>(name: string, all: One[]): One[] {
  const wanted = name.trim().toLowerCase()
  const full = all.filter((choice) => fullName(choice).toLowerCase() === wanted)
  if (full.length > 0) return full
  const byProvider = new Map<string, One[]>()
  for (const choice of all) byProvider.set(choice.provider.id, [...(byProvider.get(choice.provider.id) ?? []), choice])
  return [...byProvider.values()].flatMap((choices) => {
    const named = new Set(
      rowsNamed(
        choices.map((choice) => choice.row),
        name,
      ),
    )
    return choices.filter((choice) => named.has(choice.row))
  })
}

// The shortest name that stands for this row alone: its id, else the provider and model in full.
export const mentionName = (choice: Choice, all: Choice[]): string =>
  resolveName(choice.row.ref.id, all).length === 1 ? choice.row.ref.id : fullName(choice)
