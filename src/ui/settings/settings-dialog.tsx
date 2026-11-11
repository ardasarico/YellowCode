import { createMemo } from "solid-js"
import type { Agent } from "../../agent/agent.ts"
import type { Capabilities } from "../../agent/capabilities.ts"
import type { InputProvider } from "../../input/provider.ts"
import { modeLabel, settings } from "../../session/settings.ts"
import type { McpServerRow } from "../../agent/lists.ts"
import type { SharedSession } from "../../mcp/handover.ts"
import type { SessionInfo } from "../../session/types.ts"
import { type Tab, TabbedDialog } from "../dialog/tabbed-dialog.tsx"
import { hasShared, mcpEntries } from "../mcp/servers.ts"
import { type AgentSettings, ConfigTab } from "./config-tab.tsx"
import type { AgentOption } from "./options.ts"
import { mods } from "../../mods/mods.ts"
import { ModsTab } from "./mods-tab.tsx"
import { PluginsTab } from "./plugins-tab.tsx"
import { type ListFact, type StatusFacts, type StatusList, StatusTab } from "./status-tab.tsx"

export type SettingsTab = "status" | "config" | "plugins" | "mods"

const counted = (count: number, word: string) => (count > 0 ? [`${count} ${word}`] : [])

function mcpFact(servers: McpServerRow[] | null, shared: SharedSession | null | undefined): ListFact {
  const entries = mcpEntries(servers, shared)
  if (servers === null && entries.length === 0) return { count: null }
  const state = (word: string) => entries.filter((entry) => entry.problem === null && entry.row.state === word).length
  const held = (attention: boolean) =>
    entries.filter((entry) => entry.problem !== null && entry.attention === attention).length
  const problems = [
    ...counted(state("failed") + held(true), "failed"),
    ...counted(state("needs-login"), state("needs-login") === 1 ? "needs login" : "need login"),
    ...counted(state("off") + held(false), "off"),
  ]
  return { count: entries.length, problem: problems.join(", ") }
}

export function SettingsDialog(props: {
  tab: SettingsTab
  // The row the tab opens on: the Config tab's as /config, /output-style and /autocompact ask, the Status tab's on
  // the way back from a dialog it opened.
  row?: string
  // The agent whose session this is.
  agent: AgentOption
  // The agents installed here, for the default agent.
  agents: AgentOption[]
  // Live only.
  agentSettings?: AgentSettings
  info: SessionInfo | null
  // The session's MCP servers; null while the agent has named none. Live, the agent lists them before the first
  // message, when there is no info yet.
  servers: McpServerRow[] | null
  // Live only.
  shared?: SharedSession | null
  // Live only.
  extensions?: Pick<Agent, "plugins">
  caps: Pick<Capabilities, "plugins" | "lists">
  // The defined subagents, and how many have no model; undefined where the provider runs none of YellowCode's.
  subagents: ListFact | undefined
  // The saved rules, null until the provider lists them; undefined where it does not.
  rules: number | null | undefined
  // As the agent reports it ("default", "acceptEdits", …).
  permissionMode: string | null
  title: string | null
  model: string | null
  version: string
  provider: InputProvider
  onTab: (tab: SettingsTab) => void
  // Enter on a Status row that has a dialog of its own.
  onOpen: (list: StatusList) => void
  onClose: () => void
}) {
  const plugins = createMemo(() => props.provider.plugins(props.info))
  // The shared servers show even where the provider lists none of its own.
  const listsMcp = () => props.caps.lists.includes("mcp") || hasShared(props.shared)

  const facts = (): StatusFacts => {
    const info = props.info
    return {
      version: props.version,
      agent: props.agent.name,
      agentVersion: info?.cliVersion ?? null,
      title: props.title,
      sessionId: info?.id ?? null,
      model: props.model,
      effort: settings.effort,
      permissionMode: props.permissionMode === null ? null : modeLabel(props.provider.modes(), props.permissionMode),
      plugins: props.caps.lists.includes("plugins") ? (plugins()?.length ?? null) : undefined,
      lists: {
        mcp: listsMcp() ? mcpFact(props.servers, props.shared) : undefined,
        skills: props.caps.lists.includes("skills") ? { count: props.provider.skills()?.length ?? null } : undefined,
        agents: props.subagents,
        permissions: props.rules === undefined ? undefined : { count: props.rules },
      },
      tools: info && info.tools.length > 0 ? info.tools.length : null,
      sources: props.provider.settingSources(),
    }
  }

  const tabs: Tab<SettingsTab>[] = [
    {
      id: "status",
      label: "Status",
      render: (api) => <StatusTab api={api} facts={facts()} row={props.row} onOpen={props.onOpen} />,
    },
    {
      id: "config",
      label: "Config",
      render: (api) => (
        <ConfigTab
          api={api}
          agent={props.agent}
          modes={props.provider.modes()}
          agentSettings={props.agentSettings}
          row={props.row}
        />
      ),
    },
    {
      id: "plugins",
      label: "Plugins",
      render: (api) => (
        <PluginsTab
          api={api}
          plugins={plugins()}
          actions={props.extensions?.plugins}
          toggles={props.caps.plugins.toggle}
          hooks={props.caps.lists.includes("hooks")}
        />
      ),
    },
    {
      id: "mods",
      label: "Mods",
      render: (api) => <ModsTab api={api} host={mods} agent={props.agent} agents={props.agents} />,
    },
  ]

  // A list the agent never fills would only open empty.
  const shown = createMemo(() => tabs.filter((tab) => tab.id !== "plugins" || props.caps.lists.includes("plugins")))
  return <TabbedDialog title="Settings" tabs={shown()} tab={props.tab} onTab={props.onTab} onClose={props.onClose} />
}
