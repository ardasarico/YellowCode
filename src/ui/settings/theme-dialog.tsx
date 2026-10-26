import { settings } from "../../session/settings.ts"
import { reloadThemes } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import { choose, optionSections, preview, settingFor } from "./options.ts"

export function ThemeDialog(props: { onClose: () => void }) {
  // A theme file added since the last look shows up.
  reloadThemes()
  const setting = settingFor("theme")
  const close = () => {
    preview(settings.theme)
    props.onClose()
  }
  return (
    <Dialog
      title="Theme"
      sections={setting ? optionSections(setting) : []}
      footer={[
        { action: "Choose", key: "enter", needsRow: true },
        { action: "Cancel", key: "esc" },
      ]}
      view="theme"
      initialSelected={settings.theme}
      onSelect={(row) => preview(row.id)}
      onEnter={(row) => {
        if (setting) choose(setting, row.id)
        props.onClose()
      }}
      onKey={() => false}
      onEscape={close}
    />
  )
}
