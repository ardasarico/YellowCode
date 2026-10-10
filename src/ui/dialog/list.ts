export type DialogRow = { id: string; label: string; value?: string; note?: string; search?: string }
export type DialogSection = { title: string; rows: DialogRow[] }

export function filterSections(sections: DialogSection[], query: string): DialogSection[] {
  const needle = query.toLowerCase()
  if (!needle) return sections
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => (row.search ?? row.label).toLowerCase().includes(needle)),
    }))
    .filter((section) => section.rows.length > 0)
}

export function selectableIds(sections: DialogSection[]): string[] {
  return sections.flatMap((section) => section.rows.map((row) => row.id))
}

export function moveSelection(ids: string[], current: string | undefined, step: number): string | undefined {
  const index = current === undefined ? -1 : ids.indexOf(current)
  if (index === -1) return ids[0]
  return ids[Math.max(0, Math.min(ids.length - 1, index + step))]
}
