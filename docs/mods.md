# Mods

A mod adds something to YellowCode: a slash command, a shortcut, a pane beside the chat, a sidebar section, a tool your
agent can call, or a new way to draw part of the screen. Mods are written in TypeScript. To write one, see the [Mod
API](mod-api.md).

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

Mods live in `~/.config/yellowcode/mods/`, one folder each. There are no mods per project, so cloning a repo never runs
its code.

## Updates

Mods from the list update themselves. YellowCode checks the list once a day in the background, and an update takes
effect on the next start. It skips a mod whose files you have edited, and mods installed from GitHub or copied in by
hand; update those with `yellowcode mod update`.

A mod taken off the list stops loading, and `/mods` shows why. Its folder stays on disk.

## Managing mods

`/mods` lists your mods with a mark: ● on, ◯ off, ✕ failed, ! needs a newer YellowCode, ⊘ taken off the list. A mod from
GitHub that is not on the list is tagged "Unlisted", and one you copied in by hand "Local". The selected mod shows what
it adds, its settings and its last error.

- Space turns a mod on or off.
- → opens its settings.
- Ctrl+R reloads it.
- Ctrl+O opens its folder.

When a mod fails, YellowCode turns it off and keeps going. The line under the prompt says `! Mod <id> failed · /mods`,
and `/mods` shows the error. It loads again on the next start, or when you reload it with Ctrl+R.

If a mod keeps YellowCode from starting, run `yellowcode --no-mods` and turn it off in `/mods`.

## Examples

This repo's [`mods/`](../mods) folder has three mods you can copy into your mods folder:

- `git`: the changed files in the sidebar, with a diff on click.
- `csv`: draws `csv` and `tsv` blocks as tables.
- `terminal`: shells in a pane.
