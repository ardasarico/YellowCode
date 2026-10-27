# Usage

## Requirements

- macOS or Linux. On Windows, run it inside WSL.
- A [supported agent](../README.md#supported-agents), installed and logged in. For Claude Code, that means `claude` is
  on your `PATH`.
- For images, a terminal that can draw them, such as [Ghostty](https://ghostty.org) or
  [kitty](https://sw.kovidgoyal.net/kitty/). Other terminals and tmux work without images. YellowCode says so when it
  starts, and `--skip-terminal-check` skips that screen.

## Starting

Run `yellowcode` in the folder you want to work in. The agent starts there too.

```text
yellowcode [--skip-terminal-check] [--no-mods]
yellowcode --report
yellowcode --version
yellowcode mod <command>
```

- `--no-mods` starts without loading any mods.
- `--report` prints a summary for bug reports and exits: versions, terminal, YellowCode settings and the last lines of
  the log. `/report` inside the app copies the same text.
- `--version` prints the versions of YellowCode, its mod API and the agent.
- `yellowcode mod` installs and manages mods. See [Mods](mods.md).

## Keys

| Key                        | What it does                                                                  |
| -------------------------- | ----------------------------------------------------------------------------- |
| Enter / Shift+Enter        | Send / new line                                                               |
| Esc                        | Stop the agent's turn, or close what is open                                  |
| Esc Esc on an empty prompt | Open the timeline to rewind, once the agent is done                           |
| Ctrl+C                     | Stop the running turn or `!` command. Otherwise clear the prompt; twice quits |
| ↑ / ↓ on an empty prompt   | Your earlier messages                                                         |
| Tab                        | Move between the prompt and the chat                                          |
| Enter in the chat          | Open or fold the selected item                                                |
| End                        | Jump to the bottom of the chat                                                |
| Shift+Tab                  | Switch the permission mode: auto, accept edits, plan                          |
| Shift+← / Shift+→          | Previous or next model                                                        |
| Shift+↑ / Shift+↓          | More or less effort                                                           |
| Ctrl+T                     | Show the agents and shells running in the background                          |
| Ctrl+B                     | Send the command or agent that is running to the background                   |
| F3                         | Show or hide the sidebar                                                      |

## In the prompt

- `/` lists commands: YellowCode's own, your agent's, and those your mods add.
- `@` picks a file to mention.
- `!` at the start runs a shell command in your project. Its output goes to the agent with your next message.
- Ctrl+V pastes an image, a file or text. A long paste folds into one line, and Ctrl+X unfolds it.

## Commands

| Command     | What it does                                  |
| ----------- | --------------------------------------------- |
| `/rewind`   | Go back to before a prompt, with your files   |
| `/timeline` | Move through the prompts of this session      |
| `/redo`     | Bring back what the last rewind undid         |
| `/resume`   | Open an earlier session from this project     |
| `/export`   | Copy the conversation, or save it as Markdown |
| `/settings` | YellowCode's settings                         |
| `/theme`    | Pick a theme                                  |
| `/mods`     | See and manage your mods                      |
| `/mcp`      | The MCP servers of this session               |
| `/skills`   | The skills of this session                    |
| `/plugins`  | The plugins of this session                   |
| `/report`   | Copy a summary of your setup for a bug report |

Other commands go to your agent. YellowCode handles a few of Claude Code's itself, such as `/model`, `/effort`,
`/context`, `/usage` and `/plan`, and leaves out the few that only work in Claude Code's own screen.

## Files it writes

- Settings: `~/.config/yellowcode/settings.json`. Themes, mods and mod data live next to it, in `themes/`, `mods/` and
  `mod-data/`. All of these follow `XDG_CONFIG_HOME`.
- Log: `~/.yellowcode/logs/yellowcode.log`, or the folder in `YELLOWCODE_LOG_DIR`. `YELLOWCODE_DEBUG=1` adds debug
  lines, which can contain session text.
- Rewind snapshots: `~/.local/share/yellowcode/snapshots/`, following `XDG_DATA_HOME`. These are copies of files from
  your projects. Snapshots older than Claude Code's `cleanupPeriodDays` (30 days by default) are deleted.
- The mod list: `~/.cache/yellowcode/mods.json`, following `XDG_CACHE_HOME`.

Your agent keeps its own sessions and settings where it always does. For Claude Code that is `~/.claude`, and
`/resume` reads its session list from there.

## Updating and uninstalling

Update YellowCode with the tool you installed it with, for example `npm i -g yellowcode@latest` or
`brew upgrade yellowcode`, or run the install script again.

To remove it, uninstall it the same way, then delete the folders listed in [Files it writes](#files-it-writes):
`~/.config/yellowcode`, `~/.yellowcode`, `~/.local/share/yellowcode` and `~/.cache/yellowcode`. Your agent and its
sessions are not touched.
