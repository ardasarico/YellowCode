# Usage

## Requirements

- macOS or Linux. On Windows, run it inside WSL. Linux with musl, such as Alpine, is not supported yet.
- At least one [supported provider](../README.md#supported-providers), installed and logged in. For Claude Code, that
  means `claude` is on your `PATH`; for Codex, `codex`; for opencode, `opencode` 2 or newer; for Pi, `pi`.
- For images, a terminal that can draw them, such as [Ghostty](https://ghostty.org) or
  [kitty](https://sw.kovidgoyal.net/kitty/). Other terminals and tmux work without images. YellowCode says so when it
  starts, and `--skip-terminal-check` skips that screen.

## Starting

Run `yellowcode` in the folder you want to work in. The agent starts there too. YellowCode opens on the model you
used last, and so on its provider.

```text
yellowcode [--skip-terminal-check] [--no-mods]
yellowcode providers
yellowcode --report
yellowcode --version
yellowcode --help
yellowcode update [<version>]
yellowcode mod <command>
```

- `--no-mods` starts without loading any mods.
- `yellowcode providers` opens the list of providers in the terminal. See [Providers](#providers).
- `--report` prints a summary for bug reports and exits: versions, terminal, YellowCode settings and the last lines of
  the log. `/report` inside the app copies the same text.
- `--version` prints the versions of YellowCode, its mod API and all four providers, or `not found` for one that is
  not installed.
- `--help` prints these options.
- `yellowcode update` installs the newest version now, or the one you name. See
  [Updating and uninstalling](#updating-and-uninstalling).
- `yellowcode mod` installs and manages mods. See [Mods](mods.md).

## Keys

| Key                          | What it does                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Enter / Shift+Enter          | Send / new line                                                               |
| Esc                          | Stop the agent's turn or a running `!` command, or close what is open         |
| Esc twice on an empty prompt | Open the timeline to rewind, once the agent is done                           |
| Ctrl+C                       | Stop the running turn or `!` command. Otherwise clear the prompt; twice quits |
| ↑ / ↓ on an empty prompt     | Your earlier messages                                                         |
| Tab                          | Move between the prompt and the chat                                          |
| Enter in the chat            | Open or fold the selected item                                                |
| PageUp / PageDown            | Scroll the chat a page                                                        |
| End                          | Jump to the bottom of the chat                                                |
| Shift+Tab                    | Switch to your agent's next permission mode                                   |
| Shift+← / Shift+→            | Previous or next favorite model. See [Models](#models)                        |
| Shift+↑ / Shift+↓            | More or less effort                                                           |
| Ctrl+T                       | Show the agents, subagents and shells running in the background               |
| Ctrl+B                       | Send the command or agent that is running to the background                   |
| Ctrl+O                       | After `/report`, open the report it copied                                    |
| Ctrl+]                       | Leave a [mod pane](mods.md) that has the focus                                |
| F3                           | Show or hide the sidebar                                                      |
| F4                           | Turn ultracode on or off (Claude Code only)                                   |

On the welcome screen, ↓ moves into your recent sessions and Enter opens one.

## In the prompt

- `/` lists commands: YellowCode's own, your agent's, and those your mods add.
- `@` picks a file to mention.
- `!` on an empty prompt enters shell mode, and Esc leaves it. A line that starts with `!` runs as a shell command in
  your project. With Claude Code, its output goes to the agent with your next message; Codex, opencode and Pi do not
  get it.
- Ctrl+V pastes an image, a file or text. A long paste folds into one line: Ctrl+X unfolds it and Ctrl+Z folds it
  back. On Linux this needs `wl-clipboard` on Wayland or `xclip` on X11; your terminal's own paste works without them,
  for text.

## Commands

| Command        | What it does                                                  |
| -------------- | ------------------------------------------------------------- |
| `/rewind`      | Go back to before a prompt, with your files                   |
| `/timeline`    | Move through the prompts of this session                      |
| `/redo`        | Bring back what the last rewind undid                         |
| `/resume`      | Open an earlier session from this project                     |
| `/providers`   | Add or remove providers                                       |
| `/model`       | Pick a model of any provider you added                        |
| `/agents`      | Assign models to [subagents](agents.md#agent-files)           |
| `/rename`      | Name the session, or let the agent name it (`/rename [name]`) |
| `/export`      | Copy the conversation, or save it as Markdown                 |
| `/settings`    | YellowCode's settings                                         |
| `/theme`       | Pick a theme                                                  |
| `/mods`        | See and manage your mods                                      |
| `/mcp`         | The MCP servers of this session                               |
| `/skills`      | The skills of this session                                    |
| `/plugins`     | The plugins of this session                                   |
| `/permissions` | The rules you allowed for good, where the agent lists them    |
| `/report`      | Copy a summary of your setup for a bug report                 |

Other commands go to your agent. YellowCode handles a few itself, such as `/effort`, `/context` and `/plan`, and
`/usage` with Claude Code. It leaves out the few of Claude Code's that only work in its own screen. Each of YellowCode's
own commands hides a command of the same name your agent may have. `/model [name]` and `/effort [level]` take an
argument. With Claude Code, `/reload-skills` reloads its skills.

## Providers

Claude Code, Codex, opencode and Pi are providers. The first time you run `yellowcode`, it lists the installed ones in
the terminal: space selects, Enter goes on. If you used YellowCode before, the providers you used are added without
asking. `yellowcode providers` opens the same list later.

Inside the app, `/providers` lists the installed providers, and space adds or removes one. The provider in use and the
last one left cannot be removed. A newly installed provider is not added until you add it. Sessions of a removed
provider stay in `/resume` and still open.

When the provider meant to open cannot start, for example because you are not signed in to it, the next added one
that is installed opens instead and says why. With none left, YellowCode exits. When you are not signed in, it says
what to run; otherwise it prints `Cannot start` with the provider's name and its error.

## Models

`/model` lists your favorite models first, then one group for each provider you added, the one in use first. A group
shows 20 models and then `… N more`, which Enter opens. Type to search. opencode and Pi models carry their own
provider as a prefix, as in `anthropic/claude-opus-5-5`.

- `f` adds or removes a favorite.
- `h` hides a model, and `.` shows or leaves out the hidden ones.

Shift+← and Shift+→ walk your favorites across providers, or the models of the provider in use while you have none.

A model of the provider in use switches in place. A model of another provider starts a new session on that provider,
and the conversation moves there as text with your next message:

- Your messages and the agent's replies, and shell commands with their output.
- File changes as the file name, other tools as one line each.
- Images do not move.
- When the conversation is too long for the new model, the oldest messages are left out. The first one stays.

The old session stays in `/resume`. When Shift+← or Shift+→ lands on another provider's model, the prompt shows it and
nothing switches yet. Once the conversation has messages, sending one asks first, with what will move, and switches
only on Switch and send.

A model whose context window YellowCode does not know cannot take a conversation. Picking it says so and the session
stays where it is. A new conversation can start on it. [How it works](how-it-works.md#models-of-other-providers) says
where the windows come from.

## Files it writes

| Path                                                            | Holds                                                                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/yellowcode/settings.json`                            | Your providers, favorite and hidden models and the model you used last. `settings.json.bak` is the backup of a settings file YellowCode could not read.    |
| `~/.config/yellowcode/state.json`                               | Screen state, such as the sidebar width.                                                                                                                   |
| `~/.config/yellowcode/themes/`, `mods/`, `mod-data/`, `agents/` | Your themes, mods, mod data and agent files.                                                                                                               |
| `~/.yellowcode/models.json`                                     | The models each provider listed last, with their names, effort levels and context windows.                                                                 |
| `~/.yellowcode/logs/yellowcode.log`                             | The log, or the folder in `YELLOWCODE_LOG_DIR`. `YELLOWCODE_DEBUG=1` adds debug lines, which can contain session text.                                     |
| `~/.yellowcode/sessions/`                                       | One record and one socket for each open session, in a folder only you can read. A session removes its own when it closes.                                  |
| `~/.local/share/yellowcode/snapshots/`                          | Rewind snapshots: copies of files from your projects. Snapshots older than 30 days are deleted; with Claude Code, its `cleanupPeriodDays` is used instead. |
| `~/.yellowcode/pi-prompts/`                                     | One small file per Pi session. Rewind snapshots are filed under a prompt id that Pi does not keep, so YellowCode saves it here.                            |
| `~/.cache/yellowcode/mods.json`, `update.json`                  | The mod list and the release list.                                                                                                                         |
| `~/.yellowcode/update-state.json`, `update-hold.json`           | The state of the last update.                                                                                                                              |
| `~/.yellowcode/versions/`, `install.json`                       | The versions the install script put there, and its channel.                                                                                                |

The folders under `~/.config` follow `XDG_CONFIG_HOME`, the snapshots follow `XDG_DATA_HOME` and the cache follows
`XDG_CACHE_HOME`.

Your agent keeps its own sessions and settings where it always does: `~/.claude` for Claude Code, `~/.codex` for Codex,
opencode's own service for opencode and `~/.pi/agent` for Pi. `/resume` lists the sessions of every installed provider.

## Updating and uninstalling

YellowCode updates itself in the background, however you installed it. At start it checks for a new version if the last
check was 20 hours ago or more, and then every 20 hours while it runs. It installs what it finds, and the new version
runs from the next start. When an update cannot be installed, for example because npm's global folder needs `sudo`, a
note in the bottom right shows the command to run by hand until the update goes through. Click the note to copy the
command.

There are two channels: Stable and Beta. Pick one in `/settings` under Updates. Beta also gets every stable release.
Moving back to Stable keeps the beta you have until a stable release is newer.

`yellowcode update` installs the newest version now. `yellowcode update 0.2.1` switches to that version. After going
back to an older version, YellowCode does not install the one you left again, and updates go on once a newer one is
out. Set `YELLOWCODE_DISABLE_AUTOUPDATE=1` to turn the background updates off; `yellowcode update` still works.

To remove YellowCode, uninstall it the way you installed it:

- Install script: `rm ~/.local/bin/yellowcode` and `rm -rf ~/.yellowcode/versions`
- npm, bun or pnpm: `npm uninstall -g yellowcode`, `bun remove -g yellowcode` or `pnpm remove -g yellowcode`

Then delete the folders listed in [Files it writes](#files-it-writes): `~/.config/yellowcode`, `~/.yellowcode`,
`~/.local/share/yellowcode` and `~/.cache/yellowcode`. Your agent and its sessions are not touched.
