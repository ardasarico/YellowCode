import { settings } from "../../session/settings.ts"
import { reloadThemes } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import { optionSections, preview, THEME } from "./options.ts"

export function ThemeDialog(props: { onClose: () => void }) {
  // A theme file added since the last look shows up.
  reloadThemes()
  const close = () => {
    preview(settings.theme)
    props.onClose()
  }
  return (
    <Dialog
      title="Theme"
      sections={optionSections(THEME)}
      footer={[
        { action: "Choose", key: "enter", needsRow: true },
        { action: "Cancel", key: "esc" },
      ]}
      view="theme"
      initialSelected={settings.theme}
      onSelect={(row) => preview(row.id)}
      onEnter={(row) => {
        THEME.set(row.id)
        props.onClose()
      }}
      onKey={() => false}
      onEscape={close}
    />
  )
}
