import { batch, createSignal, untrack } from "solid-js"
import { resetSetting, setSetting, settings } from "../../session/settings.ts"
import type { StoredSettings } from "../../session/settings-file.ts"
import { setTheme, theme, themeId } from "../../theme/theme.ts"
import { Dialog } from "../dialog/dialog.tsx"
import type { DialogSection } from "../dialog/list.ts"
import { SETTINGS, type SettingDefinition } from "./options.ts"

const SECTIONS = [...new Set(SETTINGS.map((setting) => setting.section))]
const LONG = 3

const currentOption = (setting: SettingDefinition) =>
  setting.options.find((option) => option.value === settings[setting.key]) ?? setting.options[0]

function step(setting: SettingDefinition, by: 1 | -1) {
  const count = setting.options.length
  const index = setting.options.findIndex((option) => option.value === settings[setting.key])
  const next = setting.options[(index + by + count) % count]
  if (next) setSetting(setting.key, next.value)
}

const settingFor = (id: string) => SETTINGS.find((setting) => setting.key === id)
const opensList = (setting: SettingDefinition) => setting.options.length > LONG

const mainSections = (): DialogSection[] =>
  SECTIONS.map((section) => ({
    title: section,
    rows: SETTINGS.filter((setting) => setting.section === section).map((setting) => {
      const option = currentOption(setting)
      const value = opensList(setting) ? `${option?.label} →` : option?.label
      return { id: setting.key, label: setting.label, value, note: option?.note }
    }),
  }))

const optionSections = (setting: SettingDefinition): DialogSection[] => [
  {
    title: setting.label,
    rows: setting.options.map((option) => ({
      id: option.value,
      label: option.label,
      value: option.value === settings[setting.key] ? "current" : undefined,
      note: option.note,
    })),
  },
]

const preview = (id: string) => {
  if (id !== themeId()) setTheme(id)
}

// `only` opens straight on one setting's options, and leaving that list closes the dialog.
export function SettingsDialog(props: { only?: keyof StoredSettings; onClose: () => void }) {
  const only = untrack(() => props.only)
  const [list, setList] = createSignal<SettingDefinition | null>(only ? (settingFor(only) ?? null) : null)
  const [returnTo, setReturnTo] = createSignal<string>(SETTINGS[0]?.key ?? "")

  const back = (setting: SettingDefinition) => {
    if (props.only) return props.onClose()
    batch(() => {
      setReturnTo(setting.key)
      setList(null)
    })
  }

  const sections = () => {
    const open = list()
    return open ? optionSections(open) : mainSections()
  }

  const selection = () => {
    const open = list()
    return open ? settings[open.key] : returnTo()
  }

  const footer = () =>
    list()
      ? [
          { text: "Choose", fg: theme.text },
          { text: " enter  ", fg: theme.muted },
          { text: props.only ? "Cancel" : "Back", fg: theme.text },
          { text: " esc", fg: theme.muted },
        ]
      : [
          { text: "Switch", fg: theme.text },
          { text: " ←→  ", fg: theme.muted },
          { text: "Default", fg: theme.text },
          { text: " ctrl+r", fg: theme.muted },
        ]

  return (
    <Dialog
      title={props.only ? (list()?.label ?? "") : list() ? `Settings / ${list()?.label}` : "Settings"}
      sections={sections()}
      footer={footer()}
      view={list()?.key ?? "main"}
      initialSelected={selection()}
      onSelect={(row) => {
        if (list()?.key === "theme") preview(row.id)
      }}
      onEnter={(row) => {
        const open = list()
        if (open) {
          const option = open.options.find((candidate) => candidate.value === row.id)
          if (option) setSetting(open.key, option.value)
          back(open)
          return
        }
        const setting = settingFor(row.id)
        if (!setting || !opensList(setting)) return
        batch(() => {
          setReturnTo(setting.key)
          setList(setting)
        })
      }}
      onKey={(key, row) => {
        const setting = row && !list() ? settingFor(row.id) : undefined
        if (!setting) return false
        if (key.name === "left" || key.name === "right") step(setting, key.name === "left" ? -1 : 1)
        else if (key.ctrl && key.name === "r") resetSetting(setting.key)
        else return false
        return true
      }}
      onEscape={() => {
        const open = list()
        if (open?.key === "theme") preview(settings.theme)
        if (open) back(open)
        else props.onClose()
      }}
    />
  )
}
