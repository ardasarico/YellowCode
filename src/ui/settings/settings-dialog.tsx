import { createMemo } from "solid-js"
import type { PluginHook, SettingsSource, SkillRow } from "../../protocol/messages.ts"
import { pluginEntries } from "../../session/plugins.ts"
import { settings } from "../../session/settings.ts"
import { modeLabel } from "../../session/settings-file.ts"
import type { McpServer, SessionInfo } from "../../session/types.ts"
import { type Tab, TabbedDialog } from "../dialog/tabbed-dialog.tsx"
import { type McpActions, McpTab } from "../mcp/mcp-tab.tsx"
import { type ClaudeSettings, ConfigTab } from "./config-tab.tsx"
import { type PluginActions, PluginsTab } from "./plugins-tab.tsx"
import { type StatusFacts, StatusTab } from "./status-tab.tsx"

export type SettingsTab = "status" | "config" | "mcp" | "plugins"

const SOURCE_NAMES = ["user", "project", "local", "flag", "policy"]

export function SettingsDialog(props: {
  tab: SettingsTab
  // The row the Config tab opens on, as /config, /output-style and /autocompact ask.
  row?: string
  claude?: ClaudeSettings
  info: SessionInfo | null
  // Live, claude lists them before the first message, when there is no info yet.
  servers: McpServer[] | null
  mcpActions?: McpActions
  pluginActions?: PluginActions
  // As claude reports it ("default", "acceptEdits", …).
  permissionMode: string | null
  title: string | null
  model: string | null
  version: string
  skills: number
  skillRows: SkillRow[] | null
  pluginHooks: PluginHook[]
  sources: SettingsSource[]
  onTab: (tab: SettingsTab) => void
  onClose: () => void
}) {
  const plugins = createMemo(() => {
    const info = props.info
    return info ? pluginEntries(info, props.sources, props.skillRows ?? [], props.pluginHooks) : null
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
      permissionMode: props.permissionMode === null ? null : modeLabel(props.permissionMode),
      mcpServers: props.servers?.length ?? null,
      plugins: plugins()?.length ?? null,
      skills: props.skillRows ? props.skills : (info?.skills.length ?? null),
      tools: info ? info.tools.length : null,
      sources: SOURCE_NAMES.filter((name) => props.sources.some(({ source }) => source === `${name}Settings`)),
    }
  }

  const tabs: Tab<SettingsTab>[] = [
    { id: "status", label: "Status", render: (api) => <StatusTab api={api} facts={facts()} /> },
    { id: "config", label: "Config", render: (api) => <ConfigTab api={api} claude={props.claude} row={props.row} /> },
    {
      id: "mcp",
      label: "MCP",
      render: (api) => (
        <McpTab api={api} servers={props.servers} tools={props.info?.tools ?? []} actions={props.mcpActions} />
      ),
    },
    {
      id: "plugins",
      label: "Plugins",
      render: (api) => <PluginsTab api={api} plugins={plugins()} actions={props.pluginActions} />,
    },
  ]

  return <TabbedDialog title="Settings" tabs={tabs} tab={props.tab} onTab={props.onTab} onClose={props.onClose} />
}
