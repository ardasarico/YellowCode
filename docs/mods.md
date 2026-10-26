# Writing mods

A mod is a folder of TypeScript that YellowCode loads at startup. It can add slash commands, shortcuts, panes, sidebar
sections, dialogs and tools Claude can call, draw tool rows and code blocks its own way, wrap a few parts of the screen,
and change a message before it is sent.

Mods run inside the YellowCode process as trusted code. There is no sandbox: a mod can read and write your files, start
processes and reach the network, like any program you run. Only install mods you have read or trust. Installing one is
your responsibility.

## A first mod

Make a folder for it in the mods folder:

```
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
  "api": "^0.1",
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
      description: "Write a greeting to the log",
      argumentHint: "[name]",
      run(args) {
        mod.log.info(`Hello, ${args || "there"}`)
      },
    })
  },
})
```

Start YellowCode. `/hello world` now shows in the `/` list as `hello · Write a greeting to the log`, and running it
writes `[mod hello] Hello, world` to the log (see [Logging](#logging)). `/mods` lists the mod with what it adds.

## Where mods live

Mods live in `$XDG_CONFIG_HOME/yellowcode/mods/<id>/`. When `XDG_CONFIG_HOME` is not set, or is not an absolute path,
that is `~/.config/yellowcode/mods/<id>/`. There are no mods per project: cloning a repo never runs its code.

There is no installer yet. To install a mod, copy its folder into the mods folder. While you work on a mod in another
folder you can symlink it there instead, but imports are resolved from where the files really are, so give your working
folder a `node_modules` link to the one YellowCode keeps in the mods folder:

```sh
ln -s ~/my-mods/hello ~/.config/yellowcode/mods/hello
ln -s ~/.config/yellowcode/mods/node_modules ~/my-mods/hello/node_modules
```

Folders whose name starts with a dot are skipped. YellowCode looks for mods only at startup, so restart it after
adding a folder.

A mod placed in the folder is on. Turning it off in `/mods` is saved in YellowCode's `settings.json` under
`disabledMods`.

## The manifest

Every mod folder has a `yellowcode-mod.json`:

| Field         | Required | Meaning                                                                                                          |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`          | yes      | Lowercase letters and digits, words joined by single dashes. Must be the folder's name.                          |
| `name`        | yes      | The name shown in `/mods`.                                                                                       |
| `version`     | yes      | The mod's own version, shown in `/mods`.                                                                         |
| `description` | no       | One line, shown in `/mods`.                                                                                      |
| `api`         | yes      | A semver range of mod API versions the mod works with, like `"^0.1"`.                                            |
| `entry`       | yes      | The `.ts` or `.tsx` file to load, relative to the folder and inside it.                                          |
| `mcpServers`  | no       | MCP servers to give Claude while the mod is on. See [MCP servers in the manifest](#mcp-servers-in-the-manifest). |

A manifest that is missing, is not valid JSON, or has a wrong field marks the mod as failed, and `/mods` names the
problem. A mod whose `api` range does not match the running mod API version (`apiVersion`, exported by `yellowcode/mod`) is marked incompatible and is not loaded. Before 1.0 the API only gains things within a minor version, so `"^0.1"` keeps working through every 0.1.x and stops at 0.2.

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

Bun loads `.ts` and `.tsx` directly, so there is no build step. A mod may import:

- `yellowcode/mod`, the API in this guide,
- `solid-js`, `@opentui/core` and `@opentui/solid`, for views,
- Node and Bun built-ins, and the mod's own files.

YellowCode links the first four into `mods/node_modules/` when it starts, so they are the same copies the app uses.
Views are Solid components drawn with OpenTUI elements such as `<box>` and `<text>`. A mod that needs another package
can install it in its own folder, but never a second copy of `solid-js` or `@opentui/*`.

## Settings

Declare settings in `defineMod` and they show in the mod's page in `/mods`, where the user changes them. There are five
types:

```tsx
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
    mod.keys.add({ key: mod.settings.get("hotkey"), run: () => mod.notify(String(mod.settings.get("greeting"))) })
    mod.settings.onChange("greeting", (value) => mod.log.info(`greeting is now ${value}`))
  },
})
```

`mod.settings.get(id)` is typed from the declaration: a string for `text`, one of the option ids for `choice`, a
boolean, or a number. A choice stores the option's `id`, so its `label` can change without losing what users picked.
`mod.settings.set(id, value)` changes a value; one that does not fit the declaration is ignored and logged.
`onChange` runs right after a value changes, from `/mods` or from `set`.

In `/mods`, ←→ and space change a choice, a switch or a number in place, a text setting is typed after Enter, and a
`key` setting takes the next key pressed after Enter. A `key` value is a string like `"ctrl+y"`, ready for
`mod.keys.add`.
A saved value that no longer fits the declaration falls back to the default.

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

## Logging

`mod.log.info`, `warn` and `error` write to YellowCode's log, `~/.yellowcode/logs/yellowcode.log` (or the folder in
`$YELLOWCODE_LOG_DIR`), with the line prefixed `[mod <id>]`. An optional second argument is logged with it.

## When a mod fails

A mod fails when:

- its manifest is wrong or its entry has no default `defineMod` export,
- `setup` throws or its promise rejects,
- later, while it runs: a command, shortcut or event handler throws (or its promise rejects), one of its views throws
  (a pane, section, dialog, tool row, code block or wrap), or a row renderer, fence test or before-send function
  throws.

A mod that fails is turned off at once: everything it added is removed and its cleanups run. The rest of YellowCode and
the other mods keep going, and a part the mod drew goes back to the app's own. The notice line says
`! Mod <id> failed and was turned off · /mods`, or at startup `! Mod <id> failed · /mods` (`! 2 mods failed · /mods` for
more), and `/mods` shows the error with the mod's own stack frames. A failed mod loads again on the next start or a reload.

A tool that throws is different: Claude gets the error message as the tool's result, and the mod stays on.

Errors in your own timers, sockets and unawaited promises are not caught for you. Catch them and log them, as the Git
mod does.

## /mods, reloading and --no-mods

`/mods` opens the Mods tab in Settings. On the left is every mod in the folder with a marker: ● on, ◯ off, ✕ failed,
! incompatible. On the right is the selected mod: its description, folder, what it adds, its load time, MCP server
errors, its last error and its settings.

- space turns the selected mod on or off,
- r reloads it,
- enter opens its folder.

A reload stops the mod, reads its manifest again, imports its entry file fresh and runs `setup` again. Its storage and
settings stay. Edit the entry file, press r, and the change is live. Other files the entry imports are not read again, so
after editing one of those, restart YellowCode.

`yellowcode --no-mods` starts with no mods loaded and says `Mods are off (--no-mods)`. Use it when a mod gets in the way
of starting.

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

`name` is the command without the slash: lowercase letters, digits and dashes. `run` gets the rest of the line, trimmed,
and may be `async`. The `/` list shows the command with the mod's id before its description.

A name that YellowCode, Claude Code or another mod already uses is left out, with a warning in the log.

## Shortcuts

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
user types into, opened and closed with ctrl+g:

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
function that removes the handler. While the pane has the focus every key goes to the `onKey` handler, Esc and ctrl+c
included, except the mods' shortcuts and ctrl+], which leaves the pane for the chat. Text the user pastes goes to the
`onPaste` handler instead of the prompt. While the pane has the focus, keys
never answer a question Claude asks; the user leaves the pane first. The view is built again each time the pane is shown: keep state that must survive outside
the view, as the scratch text is here.

One pane is drawn per position. When the window has no room for a shown pane, it loses the focus and `/mods` says so.

## Tools for Claude

A mod can give Claude tools. Claude Code asks for permission before each call, like any MCP tool.

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

Each mod's tools form an MCP server named `mod-<id>`, which YellowCode serves itself, so Claude sees this tool as
`mcp__mod-dice__roll`. `name` is letters, digits, `_` and `-`, up to 64 characters, and unique in the mod. `inputSchema`
is the JSON schema of the arguments. `run` gets the arguments as Claude sent them, so check them yourself. It returns the text Claude reads, or
`{ text, isError: true }` for an error, and may be `async`.

The server is added to Claude when the mod loads and removed when it stops, without a restart. A tool added or removed
later reaches Claude too: YellowCode hands Claude the server again so it lists the tools anew. Tools only work in a live
session; a replay has no Claude to call them.

## MCP servers in the manifest

A mod can also bring ordinary MCP servers. List them in the manifest under `mcpServers`, in the same shape as Claude
Code's `.mcp.json`:

```json
{
  "id": "dice",
  "name": "Dice",
  "version": "0.1.0",
  "description": "Lets Claude roll dice.",
  "api": "^0.1",
  "entry": "index.ts",
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }
  }
}
```

Each one is given to Claude as `mod-<id>--<name>`, here `mod-dice--memory`, while the mod is on. YellowCode passes the
entry to Claude Code as written, so a `command` is not resolved against the mod's folder. If a server cannot connect,
`/mods` shows the error on the mod's page.

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

## Events

`mod.events.on(event, handler)` listens to:

| Event           | Data                                                          | When                                    |
| --------------- | ------------------------------------------------------------- | --------------------------------------- |
| `tool-done`     | `{ name, status }`, status `"done"`, `"error"` or `"stopped"` | One of Claude's tools finished.         |
| `turn-end`      | `{ error }`, `null` when the turn went well                   | Claude's turn ended.                    |
| `focus`         | `{}`                                                          | The terminal window got the focus back. |
| `message-sent`  | `{ text }`, after every before-send                           | The user sent a message they typed.     |
| `model-changed` | `{ model }`                                                   | The session's model changed.            |

`tool-done` and `turn-end` fire only while a turn runs, not for a session loaded from history. `focus` needs a terminal
that reports focus changes. The sidebar example above uses all three. The Git mod refreshes its file list on each of
them.

## Dialogs

`mod.dialogs` opens the app's own dialogs. One dialog is open at a time: while another one is open, while Claude asks
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

- `theme`: the current theme's colors: `background` (null when the theme leaves the terminal's own), `text`, `muted`, `faint`, `accent`, `success`, `warning`, `error`, `frame`,
  `selection` (null when the theme has none), `diffAddText` and `diffDelText`. Read them inside a view and the view
  follows a theme change. Only these are part of the API (`ModTheme`).
- `Diff`: a unified diff, as `git diff` prints it, drawn like the diffs in the chat. Props: `diff`, and optionally
  `lang` (a fence info string like `"ts"`) for highlighting and `context` lines (3 by default).
- `Code`: highlighted code with line numbers. Props: `code` and `lang`, a fence info string like `"ts"`.
- `Rule`: a line across the given `width`, in the frame color.

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
The view gets the room for its content (`width`, `height`), `onKey`, which gets every key but Esc, and `close()`. Esc
always closes the dialog. `open` returns `{ close(), closed }`, where `closed` is a promise that resolves when the
dialog closes. The Git mod's diff dialog adds a `<scrollbox>` for long diffs.

## Tool rows

A row renderer draws the rows of Claude's tool calls in the chat. This one draws Bash calls as `Shell` with a line count:

```tsx
import { defineMod, theme } from "yellowcode/mod"

export default defineMod({
  setup(mod) {
    mod.toolRows.add({
      render(tool) {
        if (tool.name !== "Bash") return null
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

- `name`: the full name, like `"Bash"` or `"mcp__mod-dice__roll"`,
- `short`: the name without the MCP prefix, like `"roll"`,
- `source`: the MCP server, like `"mod-dice"`, or `null` for Claude Code's own tools,
- `input`, `result` and `status` (`"running"`, `"done"`, `"error"` or `"stopped"`),
- `summary`: the app's one-line summary of the input, like a path or a command.

It returns the parts to draw, or `null` to leave the row to the next mod and in the end to the app. Each part left out
is drawn by the app: `title` replaces the tool's name, `text` the summary next to it, and `body` the lines under the row.
`body` gets the `width` and whether the row is `expanded`.

Mods are asked in load order, and the first one that returns parts draws the row. A mod that draws only its own tools can
check ``tool.source === `mod-${mod.id}` ``, as the Terminal mod does.

## Code fences

A fence draws a fenced code block in Claude's reply. This one draws `diff` blocks that have a hunk header with the kit's
`Diff`:

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

`langs` is a list of info strings, matched regardless of case, or a function that tests the lowercased one. `accept`, if given, gets `{ code, lang }`
and returns false for a block the mod cannot draw, which then goes to the next mod and in the end to the app. `view`
gets `code`, `lang` and `width`.

The block is drawn by the mod once it is finished; while it streams the app draws it as code. Copying a reply and
`/export` still use the raw block. The CSV mod is a fuller example.

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
mod.overrides.wrap("turn-end", (Original) => (props) => (
  <box flexDirection="column">
    <Original {...props} />
    <text fg={theme.muted}>{`  ${props.parts.reduce((sum, part) => sum + part.outputTokens, 0)} tokens out`}</text>
  </box>
))
```

`wrap` gets `Original` and returns a component with the same props. What a wrap can read is typed in
`ModOverridePoints`, a small read-only part of what the app passes:

| Point          | Props                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `user-message` | `item` (`id`, `text`, `to`), `selected`, `expanded`                                              |
| `thinking`     | `item` (`id`, `text`, `streaming`, `durationMs`), `selected`, `expanded`                         |
| `turn-end`     | `parts`, each with `durationMs`, tokens, `costUsd`, `error`, `retries`, `interrupted`, `endedAt` |
| `system-row`   | `item` (`level`, `text`, `detail`)                                                               |
| `prompt`       | `focused`, `width`, `placeholder`                                                                |
| `status-line`  | `width`, `model`, `permissionMode`, `asking`                                                     |

Pass the props on to `Original` whole, `<Original {...props} />`: the original needs more than the typed fields. A wrap
may change a field it can read, such as `item.text`, by passing `{...props, item: {...props.item, text}}`. When several mods wrap the same
point, the one loaded first wraps the app's part and a later one wraps that. If a wrap throws, its mod is turned off and
the part below it is drawn.

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

## The app and the session

A few things the app lends every mod:

```ts
mod.cwd // the project folder YellowCode was started in
mod.notify("Pushed to origin") // on the notice line under the prompt, as "<mod name>: Pushed to origin"
mod.notify("Push failed", { level: "error" }) // "info" (default), "warning" or "error"
await mod.clipboard.write(text) // false when no clipboard took it
await mod.open("https://example.com") // a URL in the browser, or a path in the user's editor
mod.prompt.insert("@notes.md ") // text at the prompt's cursor; sending stays with the user
mod.session.model() // also id(), running() and permissionMode(); null before the session is known
```

The `mod.session` values are signals: read them in a view or an effect and it follows changes. A mod cannot send a
message to Claude by itself.

## Versions and types

`apiVersion`, exported by `yellowcode/mod`, is the version of everything in this guide; the manifest's `api` names the
range a mod works with. The API is at 0.1 until YellowCode's first release. Additions raise the patch version (0.1.1)
and only add things: new fields, methods, events, union members and props. So handle a value you do not know, like a
new `status`, instead of assuming a list is complete. A change that can break a mod raises the minor version (0.2.0),
and mods asking for `"^0.1"` then show as incompatible. From 1.0 on the usual semver rules apply.

To type-check a mod, put this `tsconfig.json` in its folder. `yellowcode/mod` resolves to the API's declaration file
through the `node_modules` link described in [Where mods live](#where-mods-live):

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
    "allowImportingTsExtensions": true
  }
}
```

## Examples to read

The mods in this repo's `mods/` folder are complete examples:

- `mods/git`: a sidebar section with the changed files, refreshed on events, and a diff dialog on click.
- `mods/csv`: a fence that draws `csv` and `tsv` blocks as tables.
- `mods/terminal`: shells in a pane, settings, shortcuts read from settings, two tools for Claude and rows for them.

To try one, copy its folder into your mods folder.
