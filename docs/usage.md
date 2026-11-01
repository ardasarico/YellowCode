# Usage

## Requirements

- macOS or Linux. On Windows, run it inside WSL.
- A [supported agent](../README.md#supported-agents), installed and logged in. For Claude Code, that means `claude` is
  on your `PATH`; for Codex, `codex`; for opencode, `opencode` 2 or newer.
- For images, a terminal that can draw them, such as [Ghostty](https://ghostty.org) or
  [kitty](https://sw.kovidgoyal.net/kitty/). Other terminals and tmux work without images. YellowCode says so when it
  starts, and `--skip-terminal-check` skips that screen.

## Starting

Run `yellowcode` in the folder you want to work in. The agent starts there too.

```text
yellowcode [--skip-terminal-check] [--no-mods]
yellowcode --report
yellowcode --version
yellowcode update [<version>]
yellowcode mod <command>
```

- `--no-mods` starts without loading any mods.
- `--report` prints a summary for bug reports and exits: versions, terminal, YellowCode settings and the last lines of
  the log. `/report` inside the app copies the same text.
- `--version` prints the versions of YellowCode, its mod API and the agents you have installed.
- `yellowcode update` installs the newest version now, or the one you name. See
  [Updating and uninstalling](#updating-and-uninstalling).
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
| Shift+Tab                  | Switch to your agent's next permission mode                                   |
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

| Command        | What it does                                               |
| -------------- | ---------------------------------------------------------- |
| `/rewind`      | Go back to before a prompt, with your files                |
| `/timeline`    | Move through the prompts of this session                   |
| `/redo`        | Bring back what the last rewind undid                      |
| `/resume`      | Open an earlier session from this project                  |
| `/agent`       | Switch to another agent, in a new session                  |
| `/export`      | Copy the conversation, or save it as Markdown              |
| `/settings`    | YellowCode's settings                                      |
| `/theme`       | Pick a theme                                               |
| `/mods`        | See and manage your mods                                   |
| `/mcp`         | The MCP servers of this session                            |
| `/skills`      | The skills of this session                                 |
| `/plugins`     | The plugins of this session                                |
| `/permissions` | The rules you allowed for good, where the agent lists them |
| `/report`      | Copy a summary of your setup for a bug report              |

Other commands go to your agent. YellowCode handles a few itself, such as `/model`, `/effort`, `/context` and `/plan`,
and `/usage` with Claude Code. It leaves out the few of Claude Code's that only work in its own screen.

## Sessions working together

Every YellowCode session open on your machine can see the others and send them messages, whichever agent each one
runs. Ask your agent to hand something over, for example "give the token tests to the session in ~/work/api", and it
does the rest:

- It lists the open sessions with their title, folder, agent and model, and whether each one is busy, those of the
  same project first. Two sessions share a project when one's folder holds the other's. Inside a git repository the
  repository's root folder counts, so `app/client` and `app/server` share one.
- It sends a message to one session, in any project, or to every session of the same project. A message to every
  session on the machine, such as "I'm shutting down", needs your OK each time. It can attach paths of files and
  folders, images, and its project's `git diff`.
- The message runs in the other session as a new turn, after the current one if that session is busy. The sender does
  not wait. A reply comes back later as a message of its own.
- A session that handles a message sent to everyone can only reply to its sender.

Listing the sessions never asks for permission. Sending a message follows your agent's permission rules, like any other
tool.

Two settings under Other sessions in `/settings` apply to the open session only:

- **Incoming messages**: Run, or Ask first. With Ask first, each message waits for you and is asked like a permission.
- **Visible to them**: No hides the session from the others, and it takes no messages. It can still send.

Only sessions open in YellowCode on this machine take part. Closed sessions, sessions started outside YellowCode and
other machines do not.

## Files it writes

- Settings: `~/.config/yellowcode/settings.json`. Themes, mods and mod data live next to it, in `themes/`, `mods/` and
  `mod-data/`. All of these follow `XDG_CONFIG_HOME`.
- Log: `~/.yellowcode/logs/yellowcode.log`, or the folder in `YELLOWCODE_LOG_DIR`. `YELLOWCODE_DEBUG=1` adds debug
  lines, which can contain session text.
- Open sessions: `~/.yellowcode/sessions/`, one record and one socket for each open session, in a folder only you can
  read. A session removes its own when it closes.
- Rewind snapshots: `~/.local/share/yellowcode/snapshots/`, following `XDG_DATA_HOME`. These are copies of files from
  your projects. Snapshots older than 30 days are deleted. When YellowCode starts with Claude Code, it uses Claude Code's
  `cleanupPeriodDays` instead.
- The mod list and the release list: `~/.cache/yellowcode/mods.json` and `update.json`, following `XDG_CACHE_HOME`.
- Updates: `~/.yellowcode/` keeps the state of the last update (`update-state.json`, `update-hold.json`). The install
  script also puts its versions in `~/.yellowcode/versions/` and notes its channel in `~/.yellowcode/install.json`.

Your agent keeps its own sessions and settings where it always does: `~/.claude` for Claude Code, `~/.codex` for Codex
and opencode's own service for opencode. `/resume` lists the sessions of every installed agent.

## Updating and uninstalling

YellowCode updates itself in the background, however you installed it. It looks for a new version when it starts and
once a day while it runs, installs it, and the new version runs from the next start. When an update cannot be
installed, for example because npm's global folder needs `sudo`, a note in the bottom right shows the command to run
by hand until the update goes through.

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
