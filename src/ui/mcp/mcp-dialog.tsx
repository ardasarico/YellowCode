import { TabbedDialog } from "../dialog/tabbed-dialog.tsx"
import { McpTab } from "./mcp-tab.tsx"

type McpProps = Omit<Parameters<typeof McpTab>[0], "api">

// /mcp: the servers in the two panes of a settings tab, in a dialog of that one tab.
export function McpDialog(props: McpProps & { onClose: () => void }) {
  return (
    <TabbedDialog
      title="MCP"
      tabs={[
        {
          id: "mcp",
          label: "MCP",
          render: (api) => (
            <McpTab api={api} servers={props.servers} shared={props.shared} actions={props.actions} can={props.can} />
          ),
        },
      ]}
      tab="mcp"
      onTab={() => {}}
      onClose={props.onClose}
    />
  )
}
