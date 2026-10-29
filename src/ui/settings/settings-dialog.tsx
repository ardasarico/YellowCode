import { createMemo } from "solid-js"
import type { Agent } from "../../agent/agent.ts"
import type { Capabilities } from "../../agent/capabilities.ts"
import type { AgentKindId } from "../../agent/ids.ts"
import type { InputProvider } from "../../input/provider.ts"
import { modeLabel, settings } from "../../session/settings.ts"
import type { McpServer, SessionInfo } from "../../session/types.ts"
import { type Tab, TabbedDialog } from "../dialog/tabbed-dialog.tsx"
import { McpTab } from "../mcp/mcp-tab.tsx"
import { type AgentSettings, ConfigTab } from "./config-tab.tsx"
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
  agent: AgentKindId
  // Live only.
  agentSettings?: AgentSettings
  info: SessionInfo | null
  // Live, claude lists them before the first message, when there is no info yet.
  servers: McpServer[] | null
  // Live only.
  extensions?: Pick<Agent, "mcp" | "plugins">
  caps: Pick<Capabilities, "mcp" | "plugins" | "lists">
  // As claude reports it ("default", "acceptEdits", …).
  permissionMode: string | null
  title: string | null
  model: string | null
  version: string
  provider: InputProvider
  onTab: (tab: SettingsTab) => void
  onClose: () => void
}) {
  const plugins = createMemo(() => {
    const info = props.info
    return info ? props.provider.plugins(info) : null
  })

  const facts = (): StatusFacts => {
    const info = props.info
    return {
      version: props.version,
      claudeVersion: info?.cliVersion ?? null,
      title: props.title,
      sessionId: info?.id ?? null,
      model: props.model,
      effort: settings.effort,
      permissionMode: props.permissionMode === null ? null : modeLabel(props.provider.modes(), props.permissionMode),
      mcpServers: props.servers?.length ?? null,
      plugins: plugins()?.length ?? null,
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
        <McpTab
          api={api}
          servers={props.provider.mcp(props.servers, props.info?.tools ?? [])}
          actions={props.extensions?.mcp}
          can={props.caps.mcp}
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
    { id: "mods", label: "Mods", render: (api) => <ModsTab api={api} host={mods} /> },
  ]

  return <TabbedDialog title="Settings" tabs={tabs} tab={props.tab} onTab={props.onTab} onClose={props.onClose} />
}
