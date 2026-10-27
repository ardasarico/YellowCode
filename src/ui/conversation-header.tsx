import { settings } from "../session/settings.ts"
import { theme } from "../theme/theme.ts"
import { cut, cutPath, modelName } from "./format.ts"
import { CatOrBlank, type Workspace } from "./welcome.tsx"

const CAT_COLS = 7
const CAT_ROWS = 3
const GAP = 2

// What a /clear starts the chat with, in place of the welcome screen.
export function ConversationHeader(props: { workspace: Workspace; model: string | null; width: number }) {
  const room = () => Math.max(0, props.width - CAT_COLS - GAP)
  const setup = () =>
    [props.model ? modelName(props.model) : null, settings.effort ? `effort ${settings.effort}` : null]
      .filter(Boolean)
      .join(" · ")
  const place = () => {
    const branch = props.workspace.branch ? ` · ${props.workspace.branch}` : ""
    return cutPath(props.workspace.cwd, room() - Bun.stringWidth(branch)) + branch
  }
  return (
    <box flexDirection="row" gap={GAP} marginTop={1} flexShrink={0}>
      <CatOrBlank width={CAT_COLS} height={CAT_ROWS} />
      <box flexDirection="column">
        <text wrapMode="none">
          <span style={{ fg: theme.text, bold: true }}>YellowCode</span>
          <span style={{ fg: theme.muted }}>{cut(` v${props.workspace.version}`, room() - "YellowCode".length)}</span>
        </text>
        <text wrapMode="none" fg={theme.muted}>
          {cut(setup(), room())}
        </text>
        <text wrapMode="none" fg={theme.muted}>
          {place()}
        </text>
      </box>
    </box>
  )
}
