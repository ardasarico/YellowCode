import { expect, test } from "bun:test"
import { CUT, type PickerGroup, type PickerModel, pickerSections } from "./picker.ts"

const model = (provider: string, id: string): PickerModel => ({
  provider,
  id,
  ref: { provider: null, id },
  label: id,
})
const many = Array.from({ length: CUT + 5 }, (_, index) => model("opencode", `m${index}`))
const groups: PickerGroup[] = [
  { provider: "claude", name: "Claude Code", models: [model("claude", "opus"), model("claude", "haiku")] },
  { provider: "opencode", name: "opencode", models: many },
  { provider: "codex", name: "Codex", models: null },
]
const view = {
  query: "",
  showHidden: false,
  expanded: new Set<string>(),
  favorite: (one: PickerModel) => one.id === "haiku" || one.id === "m22",
  hidden: (one: PickerModel) => one.id === "opus",
}
const ids = (lines: ReturnType<typeof pickerSections>[number]["lines"]) =>
  lines.map((line) => (line.kind === "model" ? line.model.id : line.kind === "more" ? `+${line.count}` : "loading"))

test("favorites come first, a long group is cut, hidden models stay out", () => {
  const sections = pickerSections(groups, view)
  expect(sections.map((section) => section.title)).toEqual(["Favorites", "Claude Code", "opencode", "Codex"])
  expect(ids(sections[0]?.lines ?? [])).toEqual(["haiku", "m22"])
  expect(ids(sections[1]?.lines ?? [])).toEqual(["haiku"])
  expect(ids(sections[2]?.lines ?? [])).toEqual([...many.slice(0, CUT).map((one) => one.id), "+5"])
  expect(ids(sections[3]?.lines ?? [])).toEqual(["loading"])
})

test("expanding, searching and showing hidden models", () => {
  const expanded = pickerSections(groups, { ...view, expanded: new Set(["opencode"]) })
  expect(expanded[2]?.lines).toHaveLength(CUT + 5)
  const searched = pickerSections(groups, { ...view, query: "m2" })
  expect(ids(searched[0]?.lines ?? [])).toEqual(["m22"])
  expect(ids(searched[1]?.lines ?? [])).toEqual(["m2", "m20", "m21", "m22", "m23", "m24"])
  const shown = pickerSections(groups, { ...view, showHidden: true })
  expect(ids(shown[1]?.lines ?? [])).toEqual(["opus", "haiku"])
})
