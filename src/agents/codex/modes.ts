// Codex has two kinds of mode: access (an approval policy with a sandbox, or a permission profile) and collaboration
// (Default or Plan). They read as one list: Shift+Tab walks Read Only, Default and Plan, Plan keeps the access it had,
// and Full Access and the user's own profiles are picked from the list.
import type { ModeId } from "../../agent/ids.ts"
import type { ModeKind, ModeRow } from "../../agent/lists.ts"
import type { ThreadSettings } from "./wire/settings.ts"

export const PLAN = "plan"
const PROFILE = "profile:"

type Preset = {
  id: ModeId
  label: string
  description: string
  kind: ModeKind
  approval: string
  // thread/start's name for the sandbox, the policy thread/settings/update takes, and the built-in profile.
  sandbox: string
  policy: Record<string, unknown>
  profile: string
}

const PRESETS: Preset[] = [
  {
    id: "read-only",
    label: "Read Only",
    description: "Reads files; asks before it edits or goes online",
    kind: "readonly",
    approval: "on-request",
    sandbox: "read-only",
    policy: { type: "readOnly", networkAccess: false },
    profile: ":read-only",
  },
  {
    id: "auto",
    label: "Default",
    description: "Reads, edits and runs commands in this folder; asks before anything else",
    kind: "auto",
    approval: "on-request",
    sandbox: "workspace-write",
    policy: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    profile: ":workspace",
  },
  {
    id: "full-access",
    label: "Full Access",
    description: "Edits anywhere and goes online without asking",
    kind: "bypass",
    approval: "never",
    sandbox: "danger-full-access",
    policy: { type: "dangerFullAccess" },
    profile: ":danger-full-access",
  },
]

const PLAN_ROW: ModeRow = {
  id: PLAN,
  label: "Plan",
  description: "Plans first and changes nothing until you start",
  kind: "plan",
  cycle: true,
  available: true,
  group: null,
}

const presetRow = (preset: Preset): ModeRow => ({
  id: preset.id,
  label: preset.label,
  description: preset.description,
  kind: preset.kind,
  cycle: preset.id !== "full-access",
  available: true,
  group: null,
})

export type Profile = { id: string; description?: string | null; allowed: boolean }

// `plan`: collaborationMode/list has Plan. Built-in profiles are the presets; the others follow them.
export function modeRows(plan: boolean, profiles: Profile[]): ModeRow[] {
  const [readOnly, auto, full] = PRESETS.map(presetRow)
  const own = profiles
    .filter((profile) => !profile.id.startsWith(":"))
    .map((profile): ModeRow => ({
      id: PROFILE + profile.id,
      label: profile.id,
      description: profile.description ?? "",
      kind: "other",
      cycle: false,
      available: profile.allowed,
      group: null,
    }))
  return [readOnly, auto, ...(plan ? [PLAN_ROW] : []), full, ...own].filter((row) => row !== undefined)
}

// A preset or Plan, which every Codex has; a profile is known from the list.
export const fixedMode = (mode: ModeId): boolean => mode === PLAN || PRESETS.some((preset) => preset.id === mode)

const typeOf = (policy: unknown) =>
  typeof policy === "object" && policy !== null && "type" in policy ? String(policy.type) : ""

// The access a thread runs with, as a mode id; one that is no preset reads as Codex says it.
export function accessOf(approval: unknown, sandbox: unknown, profile: string | null): ModeId {
  const preset = PRESETS.find(
    (candidate) =>
      candidate.approval === approval &&
      (profile === null ? typeOf(candidate.policy) === typeOf(sandbox) : candidate.profile === profile),
  )
  if (preset) return preset.id
  if (profile !== null && !profile.startsWith(":")) return PROFILE + profile
  return `${typeof approval === "string" ? approval : "custom"} ${typeOf(sandbox)}`.trim()
}

export type Access = { approval: unknown; sandbox: unknown; profile: string | null }

export const accessOfSettings = (settings: ThreadSettings): Access => ({
  approval: settings.approvalPolicy,
  sandbox: settings.sandboxPolicy,
  profile: settings.activePermissionProfile?.id ?? null,
})

// thread/start's fields for a mode; Plan starts in the access Codex picks, then switches.
export function startFields(mode: ModeId): Record<string, unknown> {
  const preset = PRESETS.find((candidate) => candidate.id === mode)
  if (preset) return { approvalPolicy: preset.approval, sandbox: preset.sandbox }
  return mode.startsWith(PROFILE) ? { permissions: mode.slice(PROFILE.length) } : {}
}

// thread/settings/update's access fields for a mode. A thread that runs on a profile is switched by profile.
export function accessFields(mode: ModeId, onProfile: boolean): Record<string, unknown> | null {
  const preset = PRESETS.find((candidate) => candidate.id === mode)
  if (preset)
    return onProfile
      ? { approvalPolicy: preset.approval, permissions: preset.profile }
      : { approvalPolicy: preset.approval, sandboxPolicy: preset.policy }
  return mode.startsWith(PROFILE) ? { permissions: mode.slice(PROFILE.length) } : null
}

export const collaboration = (mode: string, model: string, effort: string | null) => ({
  collaborationMode: { mode, settings: { model, reasoning_effort: effort, developer_instructions: null } },
})
