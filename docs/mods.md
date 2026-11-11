# Mods

A mod adds something to YellowCode: a slash command, a shortcut, a pane beside the chat, a sidebar section, a tool your
agent can call, or a new way to draw part of the screen. Mods are written in TypeScript. To write one, see the
[Mod API](mod-api.md).

> [!WARNING]
> Mods run inside YellowCode as trusted code, with no sandbox. A mod can read and write your files, start programs and
> reach the network, like any program you run. Only install mods you have read or trust.

## Installing

| Command                                      | What it does                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `yellowcode mod add <id>`                    | Installs a mod from the [mod list](mod-api.md#getting-a-mod-listed), at the commit the list has reviewed. |
| `yellowcode mod add github:owner/repo[@ref]` | Installs a mod that is not on the list, from a branch, tag or commit. It shows the commit and asks first. |
| `yellowcode mod update [id]`                 | Updates one mod, or all of them without an id. A mod from GitHub asks before it moves.                    |
| `yellowcode mod remove <id>`                 | Asks, then deletes the mod.                                                                               |
| `yellowcode mod list`                        | Lists the installed mods.                                                                                 |

You can also install a listed mod from `/mods`, under Available. A new mod loads on the next start.

Mods live in `~/.config/yellowcode/mods/` (`$XDG_CONFIG_HOME/yellowcode/mods/` when `XDG_CONFIG_HOME` is set), one
folder each. There are no mods per project, so cloning a repo never runs its code.

## Updates

Mods from the list update themselves. YellowCode checks the list once a day in the background, and an update takes
effect on the next start. It skips a mod whose files you have edited, and a mod copied in by hand, which is never
updated. Update a mod installed from GitHub with `yellowcode mod update`, which asks first.

A mod taken off the list stops loading, and `/mods` shows why. Its folder stays on disk.

## Managing mods

`/mods` lists your mods with a mark:

| Mark | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| ●    | On.                                                     |
| ◯    | Off.                                                    |
| ✕    | Failed.                                                 |
| !    | Needs a newer YellowCode or a newer version of the mod. |
| ⊘    | Taken off the list.                                     |

A mod from GitHub that is not on the list is tagged "Unlisted", and one you copied in by hand "Local". The selected mod
shows what it adds, its settings and its last error.

Each mod names the providers it is made for, or works with any provider. With a provider it was not made for, it stays
off and `/mods` shows it as "not for this agent"; a listed mod shows its providers under Available before you install
it. A mod that names none was made for an older YellowCode and does not load until it is updated.

- `Space` turns a mod on or off.
- `→` opens its settings.
- `Ctrl+R` reloads it.
- `Ctrl+O` opens its folder.

In the chat, `Ctrl+]` leaves a mod pane that has focus.

When a mod fails, YellowCode turns it off, keeps going and says so under the prompt. `/mods` shows why. It
loads again on the next start, or when you reload it with `Ctrl+R`.

| When                  | The line under the prompt                      |
| --------------------- | ---------------------------------------------- |
| At start              | `! Mod <id> did not load · /mods`              |
| While YellowCode runs | `! Mod <id> failed and was turned off · /mods` |

If a mod keeps YellowCode from starting, run `yellowcode --no-mods` and turn it off in `/mods`.

## Examples

This repo's [`mods/`](../mods) folder has three mods you can copy into your mods folder:

- `git`: the changed files in the sidebar, with a diff on click, and `/git` to pick one by keyboard. In a diff, `n`
  writes a note on a line and `s` puts every note in the prompt for the agent.
- `csv`: draws `csv` and `tsv` blocks as tables.
- `terminal`: shells in a pane.
