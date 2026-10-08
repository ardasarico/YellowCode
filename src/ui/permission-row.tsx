import type { Permission } from "../session/types.ts"
import { theme } from "../theme/theme.ts"

export function PermissionRow(props: { item: Permission }) {
  return (
    <text
      fg={theme.warning}
    >{`? Permission: ${props.item.toolName} ${props.item.summary} → ${props.item.decision}`}</text>
  )
}
