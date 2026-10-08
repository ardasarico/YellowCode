import { RGBA, SyntaxStyle } from "@opentui/core"

export type Theme = {
  text: RGBA
  muted: RGBA
  frame: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  error: RGBA
}

const terminalTheme: Theme = {
  text: RGBA.defaultForeground(),
  muted: RGBA.fromIndex(8),
  frame: RGBA.fromIndex(8),
  accent: RGBA.fromIndex(4),
  success: RGBA.fromIndex(2),
  warning: RGBA.fromIndex(3),
  error: RGBA.fromIndex(1),
}

function createSyntaxStyle(t: Theme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: t.text },
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
