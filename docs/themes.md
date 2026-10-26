# Writing themes

A theme is a JSON file of colors. It runs no code, so any theme file is safe to try.

## Where themes live

Put the file in `$XDG_CONFIG_HOME/yellowcode/themes/`, which is `~/.config/yellowcode/themes/` when `XDG_CONFIG_HOME`
is not set. The file name is the theme's id: `forest.json` is the theme `forest`. Pick it with `/theme` or in
`/settings`; both read the folder each time they open, so a new file shows up without a restart.

The built-in themes are files in the same format, in this repo's `themes/` folder. Copying one is the quickest way to
start a new theme. A file with the same name as a built-in theme, like `dusk.json`, is not loaded.

## The format

```json
{
  "name": "Forest",
  "dark": {
    "background": "#14201a",
    "text": "#d5e4da",
    "muted": "#7d9486",
    "frame": "#2f4237",
    "accent": "#6fcf97",
    "warning": "#e2b86b",
    "error": "#ef7a7a",
    "band": "#1a2a22",
    "tile": "#22342a",
    "selection": "#22342a",
    "diffAdd": "#1d3326",
    "diffDel": "#3a2226",
    "diffAddText": "#8fd6a4",
    "diffDelText": "#ef7a7a",
    "agents": ["#6fcfc0", "#b49af0", "#8fd6a4", "#e2b86b", "#7fa6f5"],
    "syntax": {
      "keyword": "#b49af0",
      "string": "#8fd6a4",
      "number": "#e8a070",
      "function": "#7fa6f5",
      "type": "#6fcfc0",
      "comment": "#5f7a6a"
    }
  },
  "light": {}
}
```

`name` is what the pickers show. `dark` is used when the terminal has a dark background and `light` when it has a light
one. A theme may give only one of them; it is then used on every terminal.

Every key is required, and every color is a `#rrggbb` hex string:

| Key           | Used for                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------- |
| `background`  | Everything behind the chat, the sidebar and the panes.                                      |
| `text`        | Ordinary text.                                                                              |
| `muted`       | Secondary text: hints, times, notes. A fainter shade is mixed from it and `background`.     |
| `frame`       | Rules, borders and the edges of panes.                                                      |
| `accent`      | Selected rows in lists, links, the prompt's marks, focused edges.                           |
| `warning`     | Warnings and permission asks; a faint band behind them is mixed from it.                    |
| `error`       | Errors and failed tools; same as `warning` for its band.                                    |
| `band`        | The background of your messages, the sidebar and agent views.                               |
| `tile`        | The background of the prompt and of a row under the mouse.                                  |
| `selection`   | The background of the item selected in the chat.                                            |
| `diffAdd`     | The background of added lines in a diff.                                                    |
| `diffDel`     | The background of removed lines in a diff.                                                  |
| `diffAddText` | The text of added lines, and the color for things that went well.                           |
| `diffDelText` | The text of removed lines.                                                                  |
| `agents`      | The colors agents are drawn in, used in turn; the second one also marks `!` shell commands. |
| `syntax`      | Code highlighting: `keyword`, `string`, `number`, `function`, `type` and `comment`.         |

Claude's orange is not part of a theme.

## When a theme does not load

A file that is not valid JSON, misses a key or has a color that is not `#rrggbb` stays in the list, in the warning color
with what is wrong, like `Forest · dark.tile missing` or `Forest · dark.accent is not a color`, and cannot be picked.
Fix the file and open `/theme` again.

If the theme you chose is gone when YellowCode starts, it says `settings.json: invalid theme, using the default` and
uses the default theme. Your choice stays saved, so the theme comes back when its file does.
