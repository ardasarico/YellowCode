import { EmbeddedTerminalRenderable } from "@opentui/core"
import { extend } from "@opentui/solid/components"
import { type Dispose, defineMod } from "yellowcode/mod"
import { TerminalPane } from "./pane.tsx"
import { addRows } from "./rows.tsx"
import { createTerminals } from "./terminals.ts"
import { addTools } from "./tools.ts"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    embedded_terminal: typeof EmbeddedTerminalRenderable
  }
}

extend({ embedded_terminal: EmbeddedTerminalRenderable })

// "ctrl+1…9" or "ctrl+1-9" → "ctrl+"; tab n is that prefix plus n.
const tabPrefix = (keys: string) => keys.replace(/1\s*(?:…|\.\.\.|-)\s*9$/, "")

export default defineMod({
  settings: {
    position: { type: "choice", label: "Position", options: ["Bottom", "Right"], default: "Bottom" },
    height: { type: "number", label: "Height", min: 5, max: 60, step: 1, default: 14, unit: "rows" },
    width: { type: "number", label: "Width", min: 30, max: 160, step: 2, default: 80, unit: "columns" },
    shell: { type: "text", label: "Shell", default: "$SHELL", note: "a path, or $SHELL for your login shell" },
    keepRunning: { type: "boolean", label: "Keep running", default: true, note: "when the pane is hidden" },
    toggleKey: { type: "text", label: "Toggle key", default: "ctrl+`" },
    tabKeys: { type: "text", label: "Tab keys", default: "ctrl+1…9" },
  },
  setup(mod) {
    const right = () => mod.settings.get("position") === "Right"
    const terminals = createTerminals({
      shell: () => {
        const shell = mod.settings.get("shell").trim()
        return shell === "" || shell === "$SHELL" ? (process.env["SHELL"] ?? "/bin/sh") : shell
      },
      cwd: process.cwd(),
      size: () => ({ cols: right() ? mod.settings.get("width") : 80, rows: right() ? 24 : mod.settings.get("height") }),
      onEmpty: () => pane.hide(),
    })

    const pane = mod.panes.add({
      id: "terminal",
      title: "Terminal",
      position: () => (right() ? "right" : "bottom"),
      size: () => (right() ? mod.settings.get("width") : mod.settings.get("height")),
      onResize: (size) => mod.settings.set(right() ? "width" : "height", size),
      view: (props) => <TerminalPane {...props} terminals={terminals} />,
    })

    const open = () => {
      if (terminals.list().length === 0) terminals.add()
      pane.focus()
    }
    const hide = () => {
      pane.hide()
      if (!mod.settings.get("keepRunning")) terminals.closeAll()
    }
    // Closed: open and focus. Focused: hide. Open but not focused: focus.
    const toggle = () => (pane.focused() ? hide() : open())

    // Keys come from the settings, so a change there binds them again.
    let unbind: Dispose[] = []
    const bindKeys = () => {
      for (const dispose of unbind) dispose()
      unbind = []
      try {
        unbind.push(mod.keys.add({ key: mod.settings.get("toggleKey"), run: toggle }))
        const prefix = tabPrefix(mod.settings.get("tabKeys"))
        for (let tab = 1; tab <= 9; tab++)
          unbind.push(mod.keys.add({ key: `${prefix}${tab}`, when: "pane", run: () => terminals.select(tab) }))
      } catch (error) {
        mod.log.warn("a key setting is not a key", error)
      }
    }
    bindKeys()
    mod.settings.onChange("toggleKey", bindKeys)
    mod.settings.onChange("tabKeys", bindKeys)

    mod.commands.add({
      name: "terminal",
      description: "Show or hide your terminals; new opens another, a number switches to it",
      argumentHint: "[new|<number>]",
      run(args) {
        if (args === "new") {
          terminals.add()
          pane.focus()
        } else if (/^\d+$/.test(args)) {
          terminals.select(Number(args))
          pane.focus()
        } else toggle()
      },
    })

    addTools(mod, terminals)
    addRows(mod)
    return () => terminals.closeAll()
  },
})
