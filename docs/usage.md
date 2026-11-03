# Usage

## Requirements

- macOS or Linux. On Windows, run it inside WSL.
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
yellowcode update [<version>]
yellowcode mod <command>
```

- `--no-mods` starts without loading any mods.
- `yellowcode providers` opens the list of providers in the terminal. See [Providers](#providers).
- `--report` prints a summary for bug reports and exits: versions, terminal, YellowCode settings and the last lines of
  the log. `/report` inside the app copies the same text.
- `--version` prints the versions of YellowCode, its mod API and the providers you have installed.
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
| Shift+← / Shift+→          | Previous or next favorite model. See [Models](#models)                        |
| Shift+↑ / Shift+↓          | More or less effort                                                           |
| Ctrl+T                     | Show the agents, subagents and shells running in the background               |
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
| `/providers`   | Add or remove providers                                    |
| `/model`       | Pick a model of any provider you added                     |
| `/agents`      | Assign models to subagents                                 |
| `/export`      | Copy the conversation, or save it as Markdown              |
| `/settings`    | YellowCode's settings                                      |
| `/theme`       | Pick a theme                                               |
| `/mods`        | See and manage your mods                                   |
| `/mcp`         | The MCP servers of this session                            |
| `/skills`      | The skills of this session                                 |
| `/plugins`     | The plugins of this session                                |
| `/permissions` | The rules you allowed for good, where the agent lists them |
| `/report`      | Copy a summary of your setup for a bug report              |

Other commands go to your agent. YellowCode handles a few itself, such as `/effort`, `/context` and `/plan`, and
`/usage` with Claude Code. It leaves out the few of Claude Code's that only work in its own screen. `/providers` and
`/agents` hide a command of the same name your agent may have.

## Providers

Claude Code, Codex, opencode and Pi are providers. The first time you run `yellowcode`, it lists the installed ones in
the terminal: space selects, Enter goes on. If you used YellowCode before, the providers you used are added without
asking. `yellowcode providers` opens the same list later.

Inside the app, `/providers` lists the installed providers, and space adds or removes one. The provider in use and the
last one left cannot be removed. A newly installed provider is not added until you add it. Sessions of a removed
provider stay in `/resume` and still open.

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

## Subagents

Your session gets tools to run subagents: sessions of their own, on any provider you added, that work on a task while
your session goes on. Ask for one, for example "have a Codex model write the tests for this". Your agent runs one of
your [agents](#agent-files), or names a model directly; then you are asked first which model runs, if any. A Pi session gets no such tools, but Pi can run as a subagent.

- A subagent works in the same folder as your session. Its sessions are not saved and do not show in `/resume`.
- It never gets a wider permission mode than your session's. When even its provider's narrowest mode is wider, as with
  Pi, which asks for nothing, you are asked once in your chat whether it may run. With your session in auto or bypass
  and the agent's permissions on `inherit`, it runs without that ask. An opencode subagent under a session that asks
  runs in build mode and asks you before each edit and shell command.
- Its permission asks and questions show in your chat, marked with its name. They offer no "always" option, so no
  grant outlives the subagent.
- When it finishes, its last message, the files it edited and how long it took come back to your agent as a message.
  It stays open, so your agent can send it more work, until your agent closes it or your session ends.
- At most 6 run at once; more wait for a free slot. Subagents at once in `/settings` changes the number.
- Ctrl+T shows them in the agent panel, where you can follow one, send it a message, stop it or close it.

A subagent gets none of your session's own tools: no subagents of its own, no other sessions and no mod tools.

## Agent files

An agent is a task description with a model. Three are built in:

- **general-purpose**: does a self-contained task end to end, with your session's permissions.
- **explore**: searches and reads the code to answer a question, and changes nothing.
- **worker**: makes a well-defined change and reports what it changed.

Add your own as Markdown files in `~/.config/yellowcode/agents/` or in your project's `.yellowcode/agents/`. The file
name is the agent's name. A project file wins over a global one of the same name, and both over a built-in one.

```markdown
---
description: Reviews a diff for bugs and says what it found.
provider: opencode
model: openrouter/deepseek-v4
permissions: read-only
---

Review the changes you are given. Reply with each bug, its file and line, and why it is one.
```

- `description`: what the agent is for. Your agent reads it to choose one.
- `provider`: `claude`, `codex`, `opencode` or `pi`.
- `model`: the model's id as that provider lists it.
- `permissions`: `read-only`, `edits`, or `inherit`, the default, which goes up to your session's mode.
- `plugins`: `true` starts it with your plugins, hooks and MCP servers. Without it, it starts without them, as far as
  its provider can.

The body is the agent's instructions. An agent runs only once it has a model on a provider you added. `/agents` lists
every agent with its model: Enter picks a model, written into the agent's file (for a built-in, into a new file in
`~/.config/yellowcode/agents/`), and `e` opens the file.

## Sessions working together

Every YellowCode session open on your machine can see the others and send them messages, whichever provider each one
runs. Ask your agent to hand something over, for example "give the token tests to the session in ~/work/api", and it
does the rest:

- It lists the open sessions with their title, folder, provider and model, and whether each one is busy, those of the
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

- Settings: `~/.config/yellowcode/settings.json`, with your providers, favorite and hidden models and the model you
  used last. Themes, mods, mod data and your agent files live next to it, in `themes/`, `mods/`, `mod-data/` and
  `agents/`. All of these follow `XDG_CONFIG_HOME`.
- Models: `~/.yellowcode/models.json`, the models each provider listed last, with their names, effort levels and
  context windows.
- Log: `~/.yellowcode/logs/yellowcode.log`, or the folder in `YELLOWCODE_LOG_DIR`. `YELLOWCODE_DEBUG=1` adds debug
  lines, which can contain session text.
- Open sessions: `~/.yellowcode/sessions/`, one record and one socket for each open session, in a folder only you can
  read. A session removes its own when it closes.
- Rewind snapshots: `~/.local/share/yellowcode/snapshots/`, following `XDG_DATA_HOME`. These are copies of files from
  your projects. Snapshots older than 30 days are deleted. When YellowCode starts with Claude Code, it uses Claude Code's
  `cleanupPeriodDays` instead.
- Pi prompt ids: `~/.yellowcode/pi-prompts/`, one small file per Pi session. Pi does not keep the id YellowCode gives a
  prompt, which rewind snapshots are filed under, so YellowCode keeps it here to find them again in a resumed session.
- The mod list and the release list: `~/.cache/yellowcode/mods.json` and `update.json`, following `XDG_CACHE_HOME`.
- Updates: `~/.yellowcode/` keeps the state of the last update (`update-state.json`, `update-hold.json`). The install
  script also puts its versions in `~/.yellowcode/versions/` and notes its channel in `~/.yellowcode/install.json`.

Your agent keeps its own sessions and settings where it always does: `~/.claude` for Claude Code, `~/.codex` for Codex,
opencode's own service for opencode and `~/.pi/agent` for Pi. `/resume` lists the sessions of every installed provider.

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
