# Mod API

This guide is for writing a mod. To install and manage mods, see [Mods](mods.md).

A mod is a folder of TypeScript that YellowCode loads at startup. See [what a mod can add](#what-a-mod-can-add).

> [!WARNING]
> A mod runs inside the YellowCode process with no sandbox. Install only mods you trust.

**Start:** [A first mod](#a-first-mod) · [Setting up](#setting-up) · [What a mod can add](#what-a-mod-can-add) ·
[Examples to read](#examples-to-read)

**Basics:** [The manifest](#the-manifest) · [The entry file](#the-entry-file) · [Working on a mod](#working-on-a-mod) ·
[Settings](#settings) · [Storage](#storage)

**Screen:** [Commands](#commands) · [Shortcuts](#shortcuts) · [Panes](#panes) · [Sidebar sections](#sidebar-sections) ·
[Dialogs](#dialogs) · [The UI kit](#the-ui-kit) · [Tool rows](#tool-rows) · [Code fences](#code-fences) ·
[Overrides](#overrides)

**Agent:** [Telling the agent](#telling-the-agent) · [Tools for the agent](#tools-for-the-agent) ·
[MCP servers in the manifest](#mcp-servers-in-the-manifest) · [Events](#events) ·
[The app and the session](#the-app-and-the-session)

**Publishing:** [Versions](#versions) · [Getting a mod listed](#getting-a-mod-listed)

## A first mod

Make a folder for it in the mods folder:

```text
~/.config/yellowcode/mods/hello/
  yellowcode-mod.json
  index.tsx
```

`yellowcode-mod.json`:

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "description": "Says hello.",
  "api": "^0.2",
  "agents": "any",
  "entry": "index.tsx"
}
```

`index.tsx`:

```tsx
import { defineMod } from "yellowcode/mod"

export default defineMod({
  setup(mod) {
    mod.commands.add({
      name: "hello",
      description: "Say hello",
      argumentHint: "[name]",
      run(args) {
        mod.notify(`Hello, ${args || "there"}`)
      },
    })
  },
})
```

Start YellowCode and type `/hello world`. The `/` list shows `/hello [name]` with `hello · Say hello` beside it.
Running it shows `Hello: Hello, world` on the line under the prompt: the mod's name, then the text. `/mods` lists the mod
with what it adds.

## Setting up

A mod is a folder in `$XDG_CONFIG_HOME/yellowcode/mods/<id>/`, which is `~/.config/yellowcode/mods/<id>/` when
`XDG_CONFIG_HOME` is not set. Folders whose name starts with a dot are skipped. YellowCode looks for mods at startup
and when you switch to another agent, not while it runs, so restart it after adding a folder.

While you work on a mod in another folder you can symlink it there:

```sh
ln -s ~/my-mods/hello ~/.config/yellowcode/mods/hello
```

Bun loads `.ts` and `.tsx` directly, so there is no build step. A mod may import:

- `yellowcode/mod`, the API in this guide,
- `solid-js`, `@opentui/core` and `@opentui/solid`, for views,
- Node and Bun built-ins, and the mod's own files.

YellowCode gives every mod the copies of `yellowcode/mod`, `solid-js` and `@opentui/*` the app itself uses. Views are
Solid components drawn with OpenTUI elements such as `<box>` and `<text>`. A mod that needs another package can install
it in its own folder.

To type-check a mod, add the API's types and TypeScript as dev dependencies in its folder. `@yellowcode/mod` holds only
types and brings the Solid and OpenTUI versions YellowCode runs; its version is YellowCode's, so keep it at the version
you use:

```sh
bun add -d @yellowcode/mod @types/bun typescript
```

Then put this `tsconfig.json` next to it and run `bunx tsc`:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "@opentui/solid",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["bun"],
    "paths": { "yellowcode/mod": ["./node_modules/@yellowcode/mod"] }
  }
}
```

## What a mod can add

| API                                                    | What it adds                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| [`mod.commands`](#commands)                            | Slash commands                                                        |
| [`mod.keys`](#shortcuts)                               | Keyboard shortcuts                                                    |
| [`mod.panes`](#panes)                                  | A pane under the chat or to its right                                 |
| [`mod.sidebar`](#sidebar-sections)                     | A section in the sidebar                                              |
| [`mod.dialogs`](#dialogs)                              | Choice, input and confirm dialogs, or one with your own view          |
| [`mod.toolRows`](#tool-rows)                           | Its own way to draw a tool call in the chat                           |
| [`mod.fences`](#code-fences)                           | Its own way to draw a fenced code block                               |
| [`mod.instructions`](#telling-the-agent)               | Text added to the agent's instructions                                |
| [`mod.overrides`](#overrides)                          | A wrap around a part of the screen, or a change to a message          |
| [`mod.tools`](#tools-for-the-agent)                    | Tools the agent can call                                              |
| [`mcpServers`](#mcp-servers-in-the-manifest)           | MCP servers for the agent, in the manifest                            |
| [`mod.events`](#events)                                | A handler for tool calls, turn ends and other events                  |
| [`mod.settings`](#settings), [`mod.storage`](#storage) | Settings the user changes in `/mods`, and values kept across restarts |

The snippets in this guide go inside `setup(mod)` of a `defineMod` call, as in the first example. Imports come from
`yellowcode/mod`.

## Examples to read

The mods in this repo's `mods/` folder are complete examples:

- `mods/git`: a sidebar section with the changed files, refreshed on events, and a diff dialog on click that draws its
  own rows, takes notes on lines and puts them in the prompt.
- `mods/csv`: a fence that draws `csv` and `tsv` blocks as tables.
- `mods/terminal`: shells in a pane, settings, shortcuts read from settings, two tools for the agent and rows for them.

To try one, copy its folder into your mods folder.

## The manifest

Every mod folder has a `yellowcode-mod.json`:

| Field         | Required | Meaning                                                                                                             |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`          | yes      | Lowercase letters and digits, words joined by single dashes. Must be the folder's name.                             |
| `name`        | yes      | The name shown in `/mods`.                                                                                          |
| `version`     | yes      | The mod's own version, shown in `/mods`.                                                                            |
| `description` | no       | One line, shown in `/mods`.                                                                                         |
| `api`         | yes      | A semver range of mod API versions the mod works with, like `"^0.2"`.                                               |
| `agents`      | yes      | The agents the mod is made for, like `["claude"]`, or `"any"`. See [Agents](#agents).                               |
| `entry`       | yes      | The `.ts` or `.tsx` file to load, relative to the folder and inside it.                                             |
| `mcpServers`  | no       | MCP servers to give the agent while the mod is on. See [MCP servers in the manifest](#mcp-servers-in-the-manifest). |

A manifest that is missing, is not valid JSON, or has a wrong field marks the mod as failed, and `/mods` names the
problem. A mod whose `api` range does not match the running mod API version (`apiVersion`, exported by `yellowcode/mod`)
is marked incompatible and is not loaded. Before 1.0 the API only gains things within a minor version, so `"^0.2"` keeps
working through every 0.2.x and stops at 0.3.

### Agents

YellowCode runs one agent at a time, and `agents` says which ones the mod is made for, by id: `"claude"`, `"codex"`,
`"opencode"` or `"pi"`.
On an agent the list leaves out, the mod does not load at all, and `/mods` shows it as "not for this agent". A mod that
uses only YellowCode's own API, such as commands, panes, fences or the sidebar, can say `"any"` to load with every
agent; YellowCode does not check that it stays out of the agent-bound parts. Those are the tools a mod gives the agent
([`mod.tools`](#tools-for-the-agent) and [`mcpServers`](#mcp-servers-in-the-manifest)), and anything that relies on one
agent's own tool names, modes or replies. A manifest without `agents` does not load, and `/mods` says it needs an
`agents` list.

## The entry file

The entry's default export is the result of `defineMod`:

```tsx
import { defineMod } from "yellowcode/mod"

export default defineMod({
  settings: {/* optional, see Settings */},
  setup(mod) {
    // register what the mod adds
    return () => {
      // optional cleanup
    }
  },
})
```

`setup` gets the mod's API, `mod`, and runs once each time the mod loads: at startup, when it is turned on, and on a
reload. It may be `async`. It may return a cleanup function, which runs when the mod is turned off, reloaded or fails.
You can also register cleanups with `mod.onDispose(fn)`; they run newest first, before the returned one.

Everything a mod adds through `mod` (commands, keys, panes, sections and so on) is removed for you when it stops. Most
`add` calls also return a function that removes that one thing early; `panes.add` returns the pane instead. Effects and
memos created in `setup` stop with the mod too, but only those made before the first `await`; after it, put them in a
`createRoot` and dispose of it with `mod.onDispose`.

Keep `setup` light. YellowCode waits for every mod's `setup` before it shows its window, and `/mods` shows how long each
one took. A `setup` still running after 5 seconds fails with "setup did not finish in 5 s". Dialogs answer `null` until
the window is drawn, so do not wait for one in `setup` at startup. Start timers, sockets and processes on the first
event or command, not in `setup`.

## Working on a mod

### Logging

`mod.log.info`, `warn` and `error` write to YellowCode's log, `~/.yellowcode/logs/yellowcode.log` (or the folder in
`$YELLOWCODE_LOG_DIR`), with the line prefixed `[mod <id>]`. An optional second argument is logged with it.

### Reloading

Ctrl+R on a mod in `/mods` stops it, reads its manifest again, imports its entry file fresh and runs `setup` again. Its
storage and settings stay. Edit the entry file, press Ctrl+R, and the change is live. Other files the entry imports are
not read again, so after editing one of those, restart YellowCode. `/mods` also shows each mod's load time, what it
adds, its MCP server errors and its last error.

### When a mod fails

A mod fails when:

- its manifest is wrong or its entry has no default `defineMod` export,
- `setup` throws or its promise rejects,
- later, while it runs: a command, shortcut or event handler throws (or its promise rejects), one of its views throws (a
  pane, section, dialog, tool row, code block or wrap), or a row renderer, fence test or before-send function throws.

A mod that fails is turned off at once: everything it added is removed and its cleanups run. The rest of YellowCode and
the other mods keep going, and a part the mod drew goes back to the app's own. The notice line says `! Mod <id> failed
and was turned off · /mods`, or at startup `! Mod <id> did not load · /mods` (`! 2 mods did not load · /mods` for
more), and `/mods` shows the error with the mod's own stack frames. A failed mod loads again on the next start or a
reload.

A tool that throws is different: the agent gets the error message as the tool's result, and the mod stays on.

Errors in your own timers, sockets and unawaited promises are not caught for you. Catch them and log them, as the Git
mod does.

## Settings

Declare settings in `defineMod` and they show in the mod's page in `/mods`, where the user changes them. There are five
types:

```tsx
import { defineMod } from "yellowcode/mod"

export default defineMod({
  settings: {
    greeting: { type: "text", label: "Greeting", default: "Hello" },
    style: {
      type: "choice",
      label: "Style",
      options: [
        { id: "plain", label: "Plain" },
        { id: "loud", label: "Loud" },
      ],
      default: "plain",
    },
    count: { type: "boolean", label: "Count greetings", default: true, note: "kept across restarts" },
    repeat: { type: "number", label: "Repeat", min: 1, max: 5, step: 1, default: 1, unit: "times" },
    hotkey: { type: "key", label: "Greet key", default: "ctrl+y" },
  },
  setup(mod) {
    mod.commands.add({
      name: "hello",
      description: "Write a greeting to the log",
      argumentHint: "[name]",
      run(args) {
        let line = `${mod.settings.get("greeting")}, ${args || "there"}`
        if (mod.settings.get("style") === "loud") line = line.toUpperCase()
        if (mod.settings.get("count")) {
          const greetings = Number(mod.storage.get("greetings") ?? 0) + 1
          mod.storage.set("greetings", greetings)
          line += ` (#${greetings})`
        }
        for (let i = 0; i < mod.settings.get("repeat"); i++) mod.log.info(line)
      },
    })
    const greet = () => mod.notify(String(mod.settings.get("greeting")))
    let removeKey = mod.keys.add({ key: mod.settings.get("hotkey"), run: greet })
    mod.settings.onChange("hotkey", (key) => {
      removeKey()
      removeKey = mod.keys.add({ key, run: greet })
    })
    mod.settings.onChange("greeting", (value) => mod.log.info(`greeting is now ${value}`))
  },
})
```

`mod.settings.get(id)` is typed from the declaration: a string for `text`, one of the option ids for `choice`, a
boolean, or a number. A choice stores the option's `id`, so its `label` can change without losing what users picked.
`mod.settings.set(id, value)` changes a value; one that does not fit the declaration is ignored and logged. `onChange`
runs right after a value changes, from `/mods` or from `set`.

In `/mods`, ←→ and Space change a choice, a switch or a number in place, a text setting is typed after Enter, and a
`key` setting takes the next key pressed after Enter. A `key` value is a string like `"ctrl+y"`, ready for
`mod.keys.add`. A saved value that no longer fits the declaration falls back to the default.

## Storage

`mod.storage` keeps JSON values across restarts:

```ts
const greetings = Number(mod.storage.get("greetings") ?? 0) + 1
mod.storage.set("greetings", greetings)
```

The values live in `$XDG_CONFIG_HOME/yellowcode/mod-data/<id>.json` (`mod.storage.path`), outside the mod's folder, so
replacing the folder with a new version keeps them. `get` returns `unknown`: check the value before you use it. Each
`set` writes the file.

The same file holds the mod's setting values and the open or closed state of its sidebar sections, under keys starting
with `__yellowcode.`; `mod.storage` refuses those keys. `set(key, undefined)` removes a key.

## Commands

```tsx
mod.commands.add({
  name: "hello",
  description: "Write a greeting to the log",
  argumentHint: "[name]",
  run(args) {
    mod.log.info(`Hello, ${args || "there"}`)
  },
})
```

`name` is the command without the slash: lowercase letters, digits and dashes, starting with a letter or digit. Another
name throws. `run` gets the rest of the line, trimmed, and may be `async`. The `/` list shows the command with the mod's
id before its description.

A name that YellowCode, the agent or a mod loaded earlier already uses is left out, with a warning in the log.

## Shortcuts

The two shortcuts below use the `pane` and `save` of the [pane example](#panes).

```tsx
mod.keys.add({ key: "ctrl+g", run: () => (pane.focused() ? pane.hide() : pane.focus()) })
mod.keys.add({ key: "ctrl+l", when: "pane", run: () => save("") })
```

`key` is modifiers and a key joined by `+`, like `"ctrl+g"`, `"ctrl+shift+k"` or `"alt+n"`. The modifiers are `ctrl`,
`shift` and `alt` (`meta` and `option` mean the same as `alt`). An unknown modifier or a missing key throws.

A key of one character with no `ctrl` or `alt`, like `"g"`, is allowed but takes that character everywhere, the prompt
included; `/mods` warns about it. Ctrl+] always leaves a focused pane, so it cannot be a mod's key there.

A key with `when: "always"`, the default, works anywhere but in a dialog, also while a pane has the focus. A key with
`when: "pane"` works only while one of the mod's own panes has the focus. Pick keys YellowCode does not use: a mod's key
can shadow one of the app's.

## Panes

A pane sits under the chat or to its right, and stays while the user works in the chat. This one is a scratch pad the
user types into, opened and closed with Ctrl+G:

```tsx
import { createSignal } from "solid-js"
import { defineMod, theme } from "yellowcode/mod"

export default defineMod({
  setup(mod) {
    const [text, setText] = createSignal(String(mod.storage.get("text") ?? ""))
    const save = (next: string) => {
      setText(next)
      mod.storage.set("text", next)
    }

    const pane = mod.panes.add({
      id: "scratch",
      title: "Scratch",
      position: () => "bottom",
      size: () => 6,
      view: (props) => {
        props.onKey((key) => {
          if (key.name === "escape") pane.hide()
          else if (key.name === "backspace") save(text().slice(0, -1))
          else if (key.name === "return") save(`${text()}\n`)
          else if (key.sequence.length === 1 && !key.ctrl && !key.meta) save(text() + key.sequence)
        })
        return <text fg={props.focused ? theme.text : theme.muted}>{text() || "Type here."}</text>
      },
    })

    mod.keys.add({ key: "ctrl+g", run: () => pane.toggle() })
    mod.keys.add({ key: "ctrl+l", when: "pane", run: () => save("") })
  },
})
```

`position` is `"bottom"` or `"right"` and `size` is rows for a bottom pane or columns for a right one. Both are
functions, so they can follow a setting. The user can drag the pane's edge; `onResize(size)` gets the new size, and the
pane keeps it only if `size` returns it, for example by saving it in a setting as the Terminal mod does.

A pane starts hidden. The returned object has `show`, `hide`, `focus` (show and give it the focus), `toggle` (hide a
shown pane, or show and focus a hidden one), `visible`, `focused` and `remove`, which takes the pane away for good. A
click in the pane also gives it the focus. `title` is optional and names the pane in `/mods`.

`view` gets the room inside the pane (`width`, `height`), whether it has the focus, and `onKey`, which returns a
function that removes the handler. While the pane has the focus every key goes to the `onKey` handler, Esc and Ctrl+C
included, except the mods' shortcuts and Ctrl+], which leaves the pane for the chat. Text the user pastes goes to the
`onPaste` handler instead of the prompt. While the pane has the focus, keys never answer a question the agent asks; the
user leaves the pane first. The view is built again each time the pane is shown: keep state that must survive outside
the view, as the scratch text is here.

One pane is drawn per position. When the window has no room for a shown pane, it loses the focus and `/mods` says so.

## Sidebar sections

A section is a heading with an open/closed arrow, drawn by the app, and the mod's view under it. A click on the heading
opens or closes it, and that is remembered.

```tsx
import { createSignal } from "solid-js"
import { defineMod, theme } from "yellowcode/mod"

export default defineMod({
  setup(mod) {
    const [done, setDone] = createSignal(0)
    const [failed, setFailed] = createSignal(0)
    const [turns, setTurns] = createSignal(0)

    mod.events.on("tool-done", (tool) => {
      if (tool.status === "error") setFailed((n) => n + 1)
      else setDone((n) => n + 1)
    })
    mod.events.on("turn-end", () => setTurns((n) => n + 1))
    mod.events.on("focus", () => mod.log.info("welcome back"))

    mod.sidebar.add({
      id: "tools",
      title: "Tool calls",
      right: () => String(done() + failed()),
      visible: () => done() + failed() > 0,
      view: () => (
        <box flexDirection="column">
          <text fg={theme.text}>{`${done()} done`}</text>
          <text fg={failed() > 0 ? theme.error : theme.muted}>{`${failed()} failed`}</text>
          <text fg={theme.muted}>{`over ${turns()} turns`}</text>
        </box>
      ),
    })
  },
})
```

`right` is a short text at the right of the heading, and `visible` hides the whole section while it returns false. The
view gets the sidebar's `width`.

`zone` puts the section in one of three places:

- `"top"`: above the session title,
- `"body"`, the default: between the session title and usage,
- `"bottom"`: under usage.

`order` places it in its zone, lowest first. The built-in Tasks section is 10 and MCP is 20; a mod's section is 30 when
`order` is left out. This puts a section between Tasks and MCP, and another one at the very bottom:

```tsx
mod.sidebar.add({
  id: "pinned",
  title: "Pinned",
  order: 15,
  view: () => <text fg={theme.text}>Between Tasks and MCP</text>,
})
mod.sidebar.add({
  id: "footer",
  title: "Footer",
  zone: "bottom",
  view: (props) => <text fg={theme.muted}>{`${props.width} columns wide`}</text>,
})
```

## Dialogs

`mod.dialogs` opens the app's own dialogs. One dialog is open at a time: while another one is open, while the agent asks
the user something, or before the window is drawn, a call answers `null` at once and shows nothing.

```tsx
mod.commands.add({
  name: "branch",
  description: "Pick a branch and name a new one",
  async run() {
    const base = await mod.dialogs.choose({
      title: "Branch from",
      items: [
        { id: "main", label: "main" },
        { id: "dev", label: "dev", note: "3 ahead" },
      ],
    })
    if (base === null) return
    const name = await mod.dialogs.input({ title: "New branch", placeholder: "feat/…", initial: "feat/" })
    if (!name) return
    const ok = await mod.dialogs.confirm({
      title: `Create ${name}?`,
      message: `It starts from ${base}.`,
      action: "Create",
    })
    mod.log.info(ok ? `would create ${name} from ${base}` : "cancelled")
  },
})
```

- `choose` lists items and answers the chosen item's `id`, or `null` on Esc. A `note` shows under the selected item.
  More than eight items get a search row; `search` turns it on or off.
- `input` answers the typed text, or `null` on Esc.
- `confirm` shows a message with an action on Enter. It answers `true` on Enter and `null` on Esc.
- `open` shows your own view; see the next section.

## The UI kit

`yellowcode/mod` also exports a few of the app's parts, so a mod's views look like the rest of YellowCode:

- `theme`: the current theme's colors: `background` (null when the theme leaves the terminal's own), `text`, `muted`,
  `faint`, `accent`, `success`, `warning`, `error`, `frame`, `selection` (null when the theme has none), `diffAddText`
  and `diffDelText`, and the row tints `diffAdd` and `diffDel` (null when the theme has none). Read them inside a view and the view follows a theme change. Only these are part of the API
  (`ModTheme`).
- `Diff`: a unified diff, as `git diff` prints it, drawn like the diffs in the chat. Props: `diff`, and optionally
  `lang` (a fence info string like `"ts"`) for highlighting and `context` lines (3 by default).
- `Code`: highlighted code with line numbers. Props: `code` and `lang`, a fence info string like `"ts"`.
- `Rule`: a line across the given `width`, in the frame color.
- `syntaxStyle()`: the theme's colors for highlighted code, for the `syntaxStyle` of an OpenTUI `<code>` element when
  a view draws its own code rows.

This command opens a wide dialog with a diff; Tab switches to the file before the change:

```tsx
import { createSignal } from "solid-js"
import { Code, Diff, defineMod, Rule, theme } from "yellowcode/mod"

const before = `export function add(a: number, b: number) {\n  return a + b\n}`
const patch = `@@ -1,3 +1,3 @@
 export function add(a: number, b: number) {
-  return a + b
+  return a + b + 0
 }
`

export default defineMod({
  setup(mod) {
    mod.commands.add({
      name: "diff-view",
      description: "Show a change in a dialog",
      run() {
        const [showDiff, setShowDiff] = createSignal(true)
        mod.dialogs.open({
          title: "src/add.ts",
          wide: true,
          hints: [{ key: "tab", action: "diff/code" }],
          view: (props) => {
            props.onKey((key) => {
              if (key.name === "tab") setShowDiff((shown) => !shown)
            })
            return (
              <box flexDirection="column">
                <text fg={theme.muted}>{showDiff() ? "The change" : "The file before"}</text>
                <Rule width={props.width} />
                {showDiff() ? <Diff diff={patch} lang="ts" /> : <Code code={before} lang="ts" />}
              </box>
            )
          },
        })
      },
    })
  },
})
```

`open` takes a `title`, `wide` for nearly the whole screen instead of the usual width, footer `hints`, and the `view`.
The view gets the room for its content (`width`, `height`), `onKey`, which gets every key, and `close()`. Esc closes the
dialog. Since 0.2.2 the `onKey` handler gets Esc as well, and returning `true` for it keeps the dialog open, as a view
does to leave an input of its own; a handler that returns nothing still lets Esc close it. `open` returns `{
shown, close(), closed }`, where `shown` is false when the dialog was refused, and `closed` is a promise that resolves
when the dialog closes. The Git mod's diff dialog draws its own rows instead of `Diff`, so it can keep a cursor on a
line.

## Tool rows

A row renderer draws the rows of the agent's tool calls in the chat. This one draws shell commands as `Shell` with a
line count:

```tsx
import { defineMod, theme } from "yellowcode/mod"

export default defineMod({
  setup(mod) {
    mod.toolRows.add({
      render(tool) {
        if (tool.kind !== "shell") return null
        if (tool.status === "running") return { title: "Shell" }
        const lines = tool.result.split("\n").filter(Boolean)
        return {
          title: "Shell",
          text: tool.summary,
          body: (props) => (
            <text fg={tool.status === "error" ? theme.error : theme.muted}>
              {props.expanded ? lines.join("\n") : `  ${lines.length} lines of output`}
            </text>
          ),
        }
      },
    })
  },
})
```

`render` gets the tool call and runs again as it changes, from running to done. The call has:

- `name`: the agent's own name for the tool, like `"Bash"` or `"mcp__mod-dice__roll"` on Claude Code,
- `kind`: what the tool does, whatever the agent calls it: `"shell"`, `"read"`, `"search"`, `"edit"`, `"write"`,
  `"delete"`, `"move"`, `"fetch"`, `"websearch"`, `"agent"` (a subagent), `"message"` (to a running subagent),
  `"workflow"`, `"question"`, `"plan"`, `"mode"`, `"think"`, `"skill"`, `"todo"`, `"mcp"` or `"other"`,
- `short`: the name the app shows, without the MCP server, like `"roll"`,
- `source`: the MCP server, like `"mod-dice"`, or `null` for the agent's own tools,
- `input`, `result` and `status` (`"running"`, `"done"`, `"error"` or `"stopped"`),
- `summary`: the app's one-line summary of the input, like a path or a command.

It returns the parts to draw, or `null` to leave the row to the next mod and in the end to the app. Each part left out
is drawn by the app: `title` replaces the tool's name, `text` the summary next to it, and `body` the lines under the
row. `body` gets the `width` and whether the row is `expanded`.

Mods are asked in load order, and the first one that returns parts draws the row. A mod that draws only its own tools
can check ``tool.source === `mod-${mod.id}` ``, as the Terminal mod does.

## Code fences

A fence draws a fenced code block in the agent's reply. This one draws `diff` blocks that have a hunk header with the
kit's `Diff`:

```tsx
import { Diff, defineMod } from "yellowcode/mod"

export default defineMod({
  setup(mod) {
    mod.fences.add({
      langs: ["diff", "patch"],
      // Only blocks with a hunk header read as a diff; others stay plain code.
      accept: (block) => /^@@ /m.test(block.code),
      view: (props) => <Diff diff={props.code} />,
    })
  },
})
```

`langs` is a list of info strings, matched regardless of case, or a function that tests the lowercased one. `accept`, if
given, gets `{ code, lang }` and returns false for a block the mod cannot draw, which then goes to the next mod and in
the end to the app. `view` gets `code`, `lang` and `width`.

The block is drawn by the mod once it is finished; while it streams the app draws it as code. Copying a reply and
`/export` still use the raw block. The CSV mod is a fuller example.

The agent only writes a block it knows about. Give the fence `instructions` to tell it when and how to write one:

````tsx
mod.fences.add({
  langs: ["csv"],
  instructions: "Tabular data goes in a ```csv block with a header row; it is drawn as a table.",
  view: (props) => <Table code={props.code} width={props.width} />,
})
````

The text follows the fence: it is added with it and goes when the fence is disposed. It works as
[`mod.instructions`](#telling-the-agent) does.

## Overrides

### Wrapping a part of the screen

`mod.overrides.wrap(point, wrap)` replaces one of six parts of the screen with your own component, which gets the part
as it is drawn now and usually draws it inside:

| Point          | What it is                                    |
| -------------- | --------------------------------------------- |
| `user-message` | A message the user sent, in the chat.         |
| `thinking`     | A thinking row.                               |
| `turn-end`     | The line at the end of a turn.                |
| `system-row`   | A system line in the chat, like an API retry. |
| `prompt`       | The prompt bar.                               |
| `status-line`  | The line under the prompt.                    |

This adds the turn's output tokens under the turn-end line:

```tsx
import { theme } from "yellowcode/mod"

mod.overrides.wrap("turn-end", (Original) => (props) => (
  <box flexDirection="column">
    <Original {...props} />
    <text fg={theme.muted}>{`  ${props.parts.reduce((sum, part) => sum + part.outputTokens, 0)} tokens out`}</text>
  </box>
))
```

`wrap` gets `Original` and returns a component with the same props. What a wrap can read is typed in
`ModOverridePoints`, a small read-only part of what the app passes:

| Point          | Props                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `user-message` | `item` (`id`, `text`, `to`), `selected`, `expanded`                                                         |
| `thinking`     | `item` (`id`, `text`, `streaming`, `durationMs`), `selected`, `expanded`                                    |
| `turn-end`     | `parts`, each with `durationMs`, tokens, `costUsd`, `error`, `retries`, `interrupted`, `endedAt`; `waiting` |
| `system-row`   | `item` (`level`, `text`, `detail`)                                                                          |
| `prompt`       | `focused`, `width`, `placeholder`                                                                           |
| `status-line`  | `width`, `model`, `mode` (as `mod.session.mode()` gives it), `asking`                                       |

Pass the props on to `Original` whole, `<Original {...props} />`: the original needs more than the typed fields. A wrap
may change a field it can read, such as `item.text`, by passing `{...props, item: {...props.item, text}}`. When several
mods wrap the same point, the one loaded first wraps the app's part and a later one wraps that. If a wrap throws, its
mod is turned off and the part below it is drawn.

### Changing a message before it is sent

`mod.overrides.beforeSend(change)` sees each message the user sends. It returns the text to send, or `null` to keep the
message in the prompt, where the user sees "A mod stopped this message":

```ts
mod.overrides.beforeSend((text) => {
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) return null
  return text.replaceAll(":shrug:", "¯\\_(ツ)_/¯")
})
```

It runs on typed messages only, not on `/commands` or `!` shell commands. With several mods, each gets the text the one
before returned, in load order.

## Telling the agent

`mod.instructions.add(text)` adds text to the agent's instructions, on top of the agent's own and YellowCode's. Use it
for anything the agent should know about the mod, such as what its pane shows. It returns a function that removes the
text.

```ts
mod.instructions.add("The Terminal pane at the bottom shows the dev server; read it with terminal_read.")
```

The agent reads its instructions when a session starts, so text added, changed or removed later reaches it in the next
session. Each text is up to 800 characters, and an empty or longer one fails the mod. Keep it to a sentence or two:
every mod's text goes to every session and fills the agent's context. Subagents get none of it.

## Tools for the agent

A mod can give the agent tools. The agent asks for permission before each call, as it does for any MCP tool.

```ts
import { defineMod } from "yellowcode/mod"

export default defineMod({
  setup(mod) {
    mod.tools.add({
      name: "roll",
      description: "Roll a die and return the number it lands on.",
      inputSchema: {
        type: "object",
        properties: { sides: { type: "integer", minimum: 2, description: "How many sides the die has." } },
        required: ["sides"],
      },
      annotations: { readOnlyHint: true, title: "Roll a die" },
      run(input) {
        const sides = input.sides
        if (typeof sides !== "number" || !Number.isInteger(sides) || sides < 2)
          return { text: "sides must be a whole number of 2 or more", isError: true }
        return String(1 + Math.floor(Math.random() * sides))
      },
    })
  },
})
```

Each mod's tools form an MCP server named `mod-<id>`, which YellowCode serves itself, so Claude Code sees this tool as
`mcp__mod-dice__roll`. Tools are agent-bound: list the agents that take them in `agents`. On an agent that takes no
tools from YellowCode (Pi), the first `mod.tools.add` stops the mod, and `/mods` lists it as not for that agent. Declare
such a mod for the agents that take tools, in `agents`. `name` is letters, digits, `_` and `-`, up to 64 characters, and
unique in the mod. `annotations` takes `readOnlyHint`, `destructiveHint` and `title`; they tell the agent how the tool
behaves. `inputSchema` is the JSON schema of the arguments. `run` gets the arguments as the agent sent them,
so check them yourself. It returns the text the agent reads, or `{ text, isError: true }` for an error, and may be
`async`.

With Claude Code and opencode, the server is added to the agent when the mod loads and removed when it stops, without a
restart. A tool added or removed later reaches the agent too: YellowCode hands it the server again so it lists the tools
anew. Codex takes the tools only when a session starts, under the mod's namespace, and keeps them for that session; a
change reaches it in the next one. Tools only work in a live session; a replay has no agent to call them.

## MCP servers in the manifest

A mod can also bring ordinary MCP servers. List them in the manifest under `mcpServers`, with only the fields every
agent takes: `command`, `args` and `env` for a process, or `type` `"http"` or `"sse"` with `url` and `headers` for a
remote server. Any other field fails the manifest.

```json
{
  "id": "dice",
  "name": "Dice",
  "version": "0.1.0",
  "description": "Lets the agent roll dice.",
  "api": "^0.2",
  "agents": ["claude"],
  "entry": "index.ts",
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }
  }
}
```

A server name may use letters, digits, `_` and `-`. Each one is given to the agent as `mod-<id>--<name>`, here
`mod-dice--memory`, while the mod is on. A `command` is not resolved against the mod's folder; write `${modDir}` for
it, as in `"args": ["${modDir}/server.ts"]`. It is filled in `command`, `args`, `env` values and `url`. With Claude
Code, if a server cannot connect, `/mods` shows the error on the mod's page. On an agent that takes no MCP servers or
tools from YellowCode, a mod that adds them does not load, and `/mods` says why. Claude Code takes a mod's MCP servers
while it runs; Codex, opencode and Pi take them when a session starts, so a change reaches them in the next one.

## Events

`mod.events.on(event, handler)` listens to:

| Event           | Data                                                                | When                                    |
| --------------- | ------------------------------------------------------------------- | --------------------------------------- |
| `tool-done`     | `{ name, kind, status }`, status `"done"`, `"error"` or `"stopped"` | One of the agent's tools finished.      |
| `turn-end`      | `{ error }`, `null` when the turn went well                         | The agent's turn ended.                 |
| `focus`         | `{}`                                                                | The terminal window got the focus back. |
| `message-sent`  | `{ text }`, after every before-send                                 | The user sent a message they typed.     |
| `model-changed` | `{ model }`                                                         | The session's model changed.            |

`tool-done` and `turn-end` fire only while a turn runs, not for a session loaded from history. `focus` needs a terminal
that reports focus changes. The sidebar example above uses all three. The Git mod refreshes its file list on each of
them.

## The app and the session

A few things the app lends every mod:

```ts
mod.id // the mod's folder name, the `id` in its manifest
mod.cwd // the project folder YellowCode was started in
mod.notify("Pushed to origin") // on the notice line under the prompt, as "<mod name>: Pushed to origin"
mod.notify("Push failed", { level: "error" }) // "info" (default), "warning" or "error"
await mod.clipboard.write(text) // false when no clipboard took it
await mod.open("https://example.com") // a URL in the browser, or a path in the user's editor
mod.prompt.insert("@notes.md ") // text at the prompt's cursor; sending stays with the user
mod.session.model() // also id() and running(); null before the session is known
mod.session.mode() // { id: "acceptEdits", label: "acceptEdits", kind: "edits" }, or null
```

The `mod.session` values are signals: read them in a view or an effect and it follows changes. `mode()` is the session's
mode: `id` is the agent's own, `label` the name YellowCode shows, and `kind` what it does whatever the agent calls it:
`"default"`, `"edits"`, `"plan"`, `"auto"`, `"bypass"`, `"readonly"` or `"other"`. A mod cannot send a message to the
agent by itself.

## Versions

`apiVersion`, exported by `yellowcode/mod`, is the version of everything in this guide; the manifest's `api` names the
range a mod works with. The API is still 0.x, so a minor version may change things. Additions raise the patch version
(0.2.1) and only add things: new fields, methods, events, union members and props. So handle a value you do not know,
like a new `status` or `kind`, instead of assuming a list is complete. A change that can break a mod raises the minor
version (0.3.0), and mods asking for `"^0.2"` then show as incompatible. From 1.0 on the usual semver rules apply.

0.2 made mods agent-aware. To move a 0.1 mod: set `"api": "^0.2"`, add `agents`, read `mod.session.mode().id` where it
read `mod.session.permissionMode()`, and `props.mode?.id` where a `status-line` wrap read `props.permissionMode`. Tool
calls and `tool-done` gained `kind`. YellowCode's own question tool, which stands in for Claude Code's AskUserQuestion,
now reaches row renderers as `short` `"AskUserQuestion"` with `source` `null`, like the tool it replaces; its `name` is
unchanged.

0.2.2 hands Esc to a dialog's `onKey` handler too: returning `true` for it keeps the dialog open. A handler that returns
nothing works as before, and Esc closes the dialog.

## Getting a mod listed

The mod list is [`mods.json`](../mods.json) in this repo. The code stays in your own public GitHub repo, with
`yellowcode-mod.json` at its root. Each entry pins one version of a mod to a commit and to a hash of that commit's
files:

```json
{
  "id": "hello",
  "name": "Hello",
  "description": "Says hello.",
  "repo": "you/yellowcode-hello",
  "version": "0.1.0",
  "sha": "<the full 40-character commit SHA>",
  "treeHash": "sha256-...",
  "api": "^0.2",
  "agents": "any"
}
```

`id`, `version`, `api` and `agents` must equal the ones in the mod's manifest at that commit. The list holds one version of each
mod; there is no list of older versions.

To get listed:

1. Push the commit you want listed to your repo.
2. Add your entry to `mods` in `mods.json` in a fork of this repo. For `treeHash`, put any value of the right shape,
   like `sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`, and run `bun tools/mods-check.ts`. It checks the entries
   that differ from this repo's `main` (`--all` checks every one), downloads your commit and fails with the hash of the
   download; copy that into the entry and run it again until it passes. It also checks the manifest, refuses symlinks
   and dry-runs the dependency install.
3. Open a pull request. The check prints the link the review reads.

The first review reads the mod's full source. Every update is a new pull request that changes `version`, `sha` and
`treeHash`; the review reads the diff between the old and the new commit and the `bun.lock` diff.

A listed mod must follow these rules:

- It does not load code from the network: everything it runs is in the reviewed commit or in its locked dependencies.
- It does not update itself. Updates come through the list.
- Its source is not minified or obfuscated.
- A mod with a `package.json` also has a `bun.lock`. Its dependencies are installed from it exactly, without scripts.
- Its `mcpServers` run files inside the mod, or packages pinned to an exact version.
- `solid-js`, `@opentui/*` and `yellowcode` are only peer dependencies, and `@yellowcode/mod` only a dev dependency.
  YellowCode gives every mod its own copies, and a mod that installs one of them is refused.

A mod that breaks a rule after it is listed is taken off the list with a reason; it then stops loading for everyone who
installed it.
