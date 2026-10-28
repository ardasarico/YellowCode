import { CodeRenderable, type Selection, TextRenderable } from "@opentui/core"
import { extend } from "@opentui/solid"
import { theme } from "../theme/theme.ts"

// Without its own colours a selection only turns the text black. The frame colour stands out on bands and tiles,
// which share their colour with the theme's selection, and is read at each selection so a theme change applies.
type Selectable = { selectionBg: unknown; selectionFg: unknown }

function useThemeColours(renderable: Selectable, themed: boolean): boolean {
  if (!themed && renderable.selectionBg !== undefined) return false
  renderable.selectionBg = theme.frame
  renderable.selectionFg = theme.text
  return true
}

class SelectableText extends TextRenderable {
  private themed = false
  override onSelectionChanged(selection: Selection | null): boolean {
    this.themed = useThemeColours(this, this.themed)
    return super.onSelectionChanged(selection)
  }
}

class SelectableCode extends CodeRenderable {
  private themed = false
  override onSelectionChanged(selection: Selection | null): boolean {
    this.themed = useThemeColours(this, this.themed)
    return super.onSelectionChanged(selection)
  }
}

export const themeTextSelection = () => extend({ text: SelectableText, code: SelectableCode })
