// opencode says no plan is finished, so a plan file written in plan mode stands for it. The folder comes from the plan
// agent's own rules: it denies every edit but those it allows in its plan folder. Only an allowed folder counts, so a
// rule the user added for files such as `*.md` does not. A folder the user allowed in plan mode still counts.
import { matches, type Rule } from "./wire/session.ts"

export const planFolders = (rules: Rule[]): string[] =>
  rules
    .filter((rule) => rule.action === "edit" && rule.effect === "allow")
    .map((rule) => rule.resource)
    .filter((resource) => resource.endsWith("/*") && !resource.slice(0, -1).includes("*"))

export const inPlanFolder = (folders: string[], path: string): boolean =>
  folders.some((folder) => matches(folder, path))
