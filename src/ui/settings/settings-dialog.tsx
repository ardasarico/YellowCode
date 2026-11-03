import { createMemo } from "solid-js"
import type { Agent } from "../../agent/agent.ts"
import type { Capabilities } from "../../agent/capabilities.ts"
import type { InputProvider } from "../../input/provider.ts"
import { modeLabel, settings } from "../../session/settings.ts"
import type { McpServerRow } from "../../agent/lists.ts"
import type { SessionInfo } from "../../session/types.ts"
import { type Tab, TabbedDialog } from "../dialog/tabbed-dialog.tsx"
import { McpTab } from "../mcp/mcp-tab.tsx"
import { type AgentSettings, ConfigTab } from "./config-tab.tsx"
import type { AgentOption } from "./options.ts"
import { mods } from "../../mods/mods.ts"
import { ModsTab } from "./mods-tab.tsx"
import { PluginsTab } from "./plugins-tab.tsx"
import { type StatusFacts, StatusTab } from "./status-tab.tsx"

export type SettingsTab = "status" | "config" | "mcp" | "plugins" | "mods"

export function SettingsDialog(props: {
  tab: SettingsTab
  // The row the Config tab opens on, as /config, /output-style and /autocompact ask.
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
  extensions?: Pick<Agent, "mcp" | "plugins">
  caps: Pick<Capabilities, "mcp" | "plugins" | "lists">
  // As the agent reports it ("default", "acceptEdits", …).
  permissionMode: string | null
  title: string | null
  model: string | null
  version: string
  provider: InputProvider
  onTab: (tab: SettingsTab) => void
  onClose: () => void
}) {
  const plugins = createMemo(() => props.provider.plugins(props.info))

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
      mcpServers: props.caps.lists.includes("mcp") ? (props.servers?.length ?? null) : undefined,
      plugins: props.caps.lists.includes("plugins") ? (plugins()?.length ?? null) : undefined,
      skills: props.provider.skills()?.length ?? info?.skills.length ?? null,
      tools: info ? info.tools.length : null,
      sources: props.provider.settingSources(),
    }
  }

  const tabs: Tab<SettingsTab>[] = [
    { id: "status", label: "Status", render: (api) => <StatusTab api={api} facts={facts()} /> },
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
      id: "mcp",
      label: "MCP",
      render: (api) => (
        <McpTab api={api} servers={props.servers} actions={props.extensions?.mcp} can={props.caps.mcp} />
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
  const shown = createMemo(() =>
    tabs.filter((tab) => (tab.id !== "mcp" && tab.id !== "plugins") || props.caps.lists.includes(tab.id)),
  )
  return <TabbedDialog title="Settings" tabs={shown()} tab={props.tab} onTab={props.onTab} onClose={props.onClose} />
}
