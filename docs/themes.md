# Themes

A theme is a JSON file of colors. It runs no code, so any theme file is safe to try. Pick one with `/theme` or in
`/settings`.

## Where themes live

Put the file in `$XDG_CONFIG_HOME/yellowcode/themes/`, which is `~/.config/yellowcode/themes/` when `XDG_CONFIG_HOME` is
not set. The file name is the theme's id: `moss.json` is the theme `moss`. `/theme` and `/settings` read the folder each
time they open, so a new file shows up without a restart.

The built-in themes are files in the same format, in this repo's [`themes/`](../themes) folder. Copying one is the
quickest way to start. Give your copy a new file name: a file named like a built-in theme, such as `dusk.json` or
`terminal.json`, shows as a broken row ("a built-in theme has this name") and cannot be picked.

## The format

```json
{
  "name": "Moss",
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
  }
}
```

`name` is what the pickers show. `dark` is used when the terminal has a dark background and `light`, which has the same
keys, when it has a light one. A theme may give only one of them; it is then used on every terminal.

Every key is required, every color is a `#rrggbb` hex string, and `agents` needs at least one color:

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

The mark your provider shows after each answer, like Claude's orange spark, keeps its own color.

## When a theme does not load

A file that is not valid JSON, misses a key or has a value of the wrong kind stays in the list, in the warning color
with what is wrong, and cannot be picked:

- `Moss · dark.tile missing`
- `Moss · dark.accent is not a color`
- `Moss · dark.agents is not a list of colors`

Fix the file and open `/theme` again.

If the theme you chose is gone when YellowCode starts, it says `settings.json: invalid theme, using the default` and
uses the default theme. Your choice stays saved, so the theme comes back when its file does.
