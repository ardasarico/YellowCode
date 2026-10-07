import { RGBA, SyntaxStyle } from "@opentui/core"

export type Theme = {
  text: RGBA
  muted: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  error: RGBA
}

const terminalTheme: Theme = {
  text: RGBA.defaultForeground(),
  muted: RGBA.fromIndex(8),
  accent: RGBA.fromIndex(4),
  success: RGBA.fromIndex(2),
  warning: RGBA.fromIndex(3),
  error: RGBA.fromIndex(1),
}

function createSyntaxStyle(t: Theme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: t.text },
    conceal: { fg: t.muted },
    "markup.heading": { fg: t.accent, bold: true },
    "markup.heading.1": { fg: t.accent, bold: true, underline: true },
    "markup.heading.2": { fg: t.accent, bold: true },
    "markup.heading.3": { fg: t.accent, bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.strikethrough": { dim: true },
    "markup.raw": { fg: t.success },
    // OpenTUI's streaming preview draws list markers unstyled; styling them here makes them flicker on every delta.
    "markup.list": {},
    "markup.quote": { fg: t.muted, italic: true },
    "markup.link": { fg: t.accent, underline: true },
    "markup.link.label": { fg: t.accent },
    "markup.link.url": { fg: t.muted, underline: true },
    keyword: { fg: t.accent, bold: true },
    string: { fg: t.success },
    comment: { fg: t.muted, italic: true },
    number: { fg: t.warning },
    function: { fg: t.accent },
    type: { fg: t.warning },
  })
}

export const theme = terminalTheme
export const syntaxStyle = createSyntaxStyle(theme)
