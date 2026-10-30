import type { AskId, ModeId, TaskId, ToolId } from "./ids.ts"
import type { Hunk, ToolKind } from "./tools.ts"

// How long a yes or a no holds. `kept`: it is kept, but the agent does not say where.
export type Lasts = "once" | "turn" | "session" | "project" | "everywhere" | "kept"

// The band shows the options in the agent's order; Esc picks the first deny that lasts once.
export type AskOption = {
  id: string
  effect: "allow" | "deny"
  lasts: Lasts
  // The agent's own words for the option, when it names its options; else the band words it.
  label: string | null
  // What a lasting option covers, in the agent's words: a command prefix, a path, a mode.
  subject: string | null
  // Picking it opens the note field; set only where the agent takes a note (caps.askNote).
  note: boolean
  // Picking it also ends the turn.
  endsTurn: boolean
  // A plan option: the mode the agent goes on in.
  mode: ModeId | null
  // The agent's own form of what a lasting option adds; only its adapter reads it.
  grant?: unknown
}

export type QuestionPage = {
  // What the answer is filed under: the question text, a field id.
  key: string
  header: string
  question: string
  multi: boolean
  gallery: boolean
  // A typed answer is taken besides the options.
  custom: boolean
  options: { label: string; description: string | null; preview: string | null; image: string | null }[]
}

// Each row is answered on the same scale, under the row's label.
export type Matrix = { header: string; question: string; rows: string[]; scale: string[] }

export type FieldValue = string | number | boolean | string[]

// A typed field of a form, as agent forms and MCP elicitations have them. It shows only while each `when` holds.
export type FormField = {
  key: string
  title: string
  description: string | null
  control:
    | {
        type: "text"
        format: "email" | "uri" | "date" | "date-time" | null
        minLength: number | null
        maxLength: number | null
        placeholder: string | null
      }
    | { type: "number"; integer: boolean; min: number | null; max: number | null }
    | { type: "toggle" }
    | {
        type: "choice"
        multi: boolean
        options: { value: string; label: string; description: string | null }[]
        // A typed answer is taken besides the options.
        custom: boolean
        min: number | null
        max: number | null
      }
    // A page for the user to open, such as a sign-in; it takes no value.
    | { type: "link"; url: string }
  required: boolean
  default: FieldValue | null
  when: { key: string; op: "eq" | "neq"; value: string | number | boolean }[]
}

// A question or field the agent marks secret never gets here: its adapter declines it, so no band, store, log or
// recording sees it.
export type Questions =
  | { pages: QuestionPage[] }
  | { matrix: Matrix }
  | { form: { title: string; fields: FormField[] } }

// What the band shows under the main line, beyond text.
export type AskPreview =
  | { type: "diff"; files: { path: string; hunks: Hunk[] }[] }
  // A multi-agent run's plan (feature workflows); `source` is what "view the script" shows.
  | {
      type: "phases"
      name: string
      source: string
      phases: { title: string; detail: string; agents: { label: string; prompt: string }[] }[]
      loose: { label: string; prompt: string }[]
    }

export type Ask = {
  id: AskId
  kind: "permission" | "question" | "plan"
  // The tool call the ask is about.
  call: ToolId | null
  tool: { name: string; kind: ToolKind; mcp: { server: string; tool: string } | null }
  title: string
  // The call's own input, as the agent gave it; for mods and display only.
  input: unknown
  // The band's main line: a command, a path, a URL, a call's arguments.
  target: string
  preview: AskPreview | null
  // The files the call will create, change or delete, spelled as its FileChange.path will be; empty when it writes
  // nothing.
  writes: string[]
  detail: string
  reason: string
  options: AskOption[]
  questions: Questions | null
  plan: { text: string; path: string | null } | null
  defaultNo: boolean
  // The agent's own safety check flagged the call.
  safety: boolean
  // The subagent that asks; null for the main agent.
  by: TaskId | null
  // A call to YellowCode's own ask tool; `handle` is the adapter's id for the call it answers.
  own: { handle: string | number } | null
}

// Keys are the pages' keys, a matrix's row labels, or a form's field keys. `note` goes with the whole ask.
export type Answers = {
  values: Record<string, string[]>
  fields: Record<string, FieldValue>
  notes: Record<string, string>
  note: string
}

export type AskReply =
  | { type: "option"; option: string; note: string | null }
  | { type: "answers"; answers: Answers }
  // Questions left unanswered; `chat`: the user wants to talk them over in the chat.
  | { type: "declined"; chat: boolean }

// Why a no reached the agent. `unshown`: YellowCode turned the call down unseen, `note` says why; `subagent`: only the
// main agent may ask.
export type Denial = "declined" | "chat" | "unshown" | "subagent"

// What the agent took. `said` is the text a no reached it with; the chat words it from `why` and `note`. Form values
// are written as text in `answers`.
export type AskOutcome =
  | { status: "allowed" }
  | { status: "denied"; said: string; why: Denial; note: string }
  | { status: "answered"; answers: Record<string, string>; notes: Record<string, string> }
  | { status: "cancelled" }
