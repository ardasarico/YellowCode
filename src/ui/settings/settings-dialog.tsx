import { createMemo } from "solid-js"
import type { PluginHook, SettingsSource, SkillRow } from "../../protocol/messages.ts"
import { pluginEntries } from "../../session/plugins.ts"
import { settings } from "../../session/settings.ts"
import type { SessionInfo } from "../../session/types.ts"
import { type Tab, TabbedDialog } from "../dialog/tabbed-dialog.tsx"
import { McpTab } from "../mcp/mcp-tab.tsx"
import { ConfigTab } from "./config-tab.tsx"
import { PluginsTab } from "./plugins-tab.tsx"
import { type StatusFacts, StatusTab } from "./status-tab.tsx"

export type SettingsTab = "status" | "config" | "mcp" | "plugins"

const SOURCE_NAMES = ["user", "project", "local", "flag", "policy"]

export function SettingsDialog(props: {
  tab: SettingsTab
  info: SessionInfo | null
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
      permissionMode: info?.permissionMode ?? null,
      mcpServers: info ? info.mcpServers.length : null,
      plugins: plugins()?.length ?? null,
      skills: props.skillRows ? props.skills : (info?.skills.length ?? null),
      tools: info ? info.tools.length : null,
      sources: SOURCE_NAMES.filter((name) => props.sources.some(({ source }) => source === `${name}Settings`)),
    }
  }

  const tabs: Tab<SettingsTab>[] = [
    { id: "status", label: "Status", render: (api) => <StatusTab api={api} facts={facts()} /> },
    { id: "config", label: "Config", render: (api) => <ConfigTab api={api} /> },
    { id: "mcp", label: "MCP", render: (api) => <McpTab api={api} info={props.info} /> },
    { id: "plugins", label: "Plugins", render: (api) => <PluginsTab api={api} plugins={plugins()} /> },
  ]

  return <TabbedDialog title="Settings" tabs={tabs} tab={props.tab} onTab={props.onTab} onClose={props.onClose} />
}
