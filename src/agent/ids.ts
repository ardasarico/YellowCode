// Opaque ids. An adapter may use the agent's own ids as they are; nothing outside it reads them.
export type AgentKindId = string
// Made by YellowCode at Enter; rewind manifests and the chat key a prompt by it, so history gives back the same id.
export type PromptId = string
// One block of text or thinking.
export type PartId = string
// A tool call; it is also the call's chat item id.
export type ToolId = string
export type TaskId = string
export type AskId = string
export type ModeId = string
export type EffortId = string

// `provider` is null for an agent with one provider.
export type ModelRef = { provider: string | null; id: string }

// `note` says what changed, such as the file a switch wrote. An intent that returns an Outcome resolves and never rejects.
export type Outcome = { ok: true; note: string | null } | { ok: false; problem: string }
