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
yellowcode mcp <command>
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
- `yellowcode mcp` adds, lists and removes the MCP servers every provider gets. See
  [Shared MCP servers](#shared-mcp-servers).

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
  your project. Its output goes to the agent with your next message. Claude Code also reads it at once when it is
  idle; Codex, opencode and Pi wait for your message.
- Ctrl+V pastes an image, a file or text. A long paste folds into one line: Ctrl+X unfolds it and Ctrl+Z folds it
  back. On Linux this needs `wl-clipboard` on Wayland or `xclip` on X11; your terminal's own paste works without them,
  for text.

## Commands

| Command        | What it does                                                                    |
| -------------- | ------------------------------------------------------------------------------- |
| `/rewind`      | Open the timeline of the session to go back to before a prompt, with your files |
| `/redo`        | Bring back what the last rewind undid                                           |
| `/resume`      | Open an earlier session from this project                                       |
| `/providers`   | Add or remove providers                                                         |
| `/model`       | Pick a model of any provider you added                                          |
| `/agents`      | Assign models to [subagents](agents.md#agent-files)                             |
| `/rename`      | Name the session, or let the agent name it (`/rename [name]`)                   |
| `/export`      | Copy the conversation, or save it as Markdown                                   |
| `/settings`    | YellowCode's settings, and an overview of the session                           |
| `/theme`       | Pick a theme                                                                    |
| `/mods`        | See and manage your mods                                                        |
| `/mcp`         | The MCP servers of this session                                                 |
| `/skills`      | The skills of this session                                                      |
| `/plugins`     | The plugins of this session                                                     |
| `/permissions` | The rules you allowed for good, where the agent lists them                      |
| `/report`      | Copy a summary of your setup for a bug report                                   |

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
- The images you pasted or attached, the newest four, attached to your next message. Images from tools do not move,
  and neither do those of a resumed session that YellowCode no longer has.
- When the conversation is too long for the new model, the oldest messages are left out. The first one stays.

The old session stays in `/resume`. When Shift+← or Shift+→ lands on another provider's model, the prompt shows it and
nothing switches yet. Once the conversation has messages, sending one asks first, with what will move, and switches
only on Switch and send.

A model whose context window YellowCode does not know cannot take a conversation. Picking it says so and the session
stays where it is. A new conversation can start on it. [How it works](how-it-works.md#models-of-other-providers) says
where the windows come from.

## Shared MCP servers

YellowCode keeps one list of MCP servers and gives it to whichever provider runs the session, on top of the provider's
own. The list comes from two files, both in the `mcpServers` shape of Claude Code's `.mcp.json`:

- `~/.config/yellowcode/mcp.json`, for every project.
- The project's `.mcp.json`, the nearest one from the folder you start in up to the project's root. A server here
  replaces the global one of the same name.

Claude Code reads every `.mcp.json` from the folder up to `/` by itself. YellowCode switches the servers of all of
them off for Claude Code and asks only about the project's own.

`yellowcode mcp` writes them for you:

```text
yellowcode mcp add github -e GITHUB_TOKEN -- npx -y @modelcontextprotocol/server-github
yellowcode mcp add docs --project --url https://example.com/mcp -H 'Authorization: Bearer ${DOCS_TOKEN}'
yellowcode mcp list
yellowcode mcp remove github [--project]
```

`add` writes to the global file, or with `--project` to the project's `.mcp.json`. A command server takes `-e` for
each variable, a URL server `-H` for each header and `--transport http` (the default) or `sse`. `list` shows each
server with its program or URL and the names of its variables, never their values.

Secrets stay out of the files: write them as `${VAR}` or `${VAR:-default}`, and YellowCode fills them in from its own
environment when a session starts. `-e GITHUB_TOKEN` writes `${GITHUB_TOKEN}`. `add` refuses a literal value, such as
`-e GITHUB_TOKEN=ghp_…`, and says how to write it. A server whose variable is not set is left out, and `/mcp` shows
`needs $GITHUB_TOKEN`.

A project's `.mcp.json` comes with the code, so YellowCode asks before it uses its servers. The question opens in the
chat when a session starts. For each server it shows the command line or URL as the file has it, the folder it runs
in, the names of the variables it sets and of yours it reads, and which of yours a URL server sends to which host. A
server that sets a variable that changes what a program loads, such as `PATH`, `NODE_OPTIONS` or `LD_PRELOAD`, gets a
warning line. `v` shows the whole list. Yes uses them, and No leaves them out. Esc leaves the question for the next
start. A changed file asks again. Until you answer, `/mcp` shows them as `waiting for your yes`. A yes reaches Claude
Code at once. Another provider gets them in a new session, which starts at once if you have not sent a message yet;
otherwise `/mcp` shows them as `starts with the next session`.

A name has 1 to 32 letters, digits, `-` or `_`. `yellowcode`, `yellowcode-sessions`, `yellowcode-agents` and names
that start with `mod-` are YellowCode's own. A project server with another name, or an entry YellowCode cannot read,
is left out, for Claude Code too, and `/mcp` shows why. Servers with different names are never merged or dropped. When a shared
server has the name of one of your provider's own, the shared one wins and the provider's own is off for the session.
Where the provider shows it had one, `/mcp` lists it as `off · replaced by the shared <name>`. When Claude Code's or
Codex's own runs another program or URL, a notice says so, once for each name.

Providers' own MCP servers in `/settings` decides what else runs. On, the default, each provider also runs the servers
of its own config. Off, it runs only the shared servers, the mods' and YellowCode's own tools. It applies from the next
session.

`/mcp` lists the shared servers first, under Shared, with the state the provider reports. A server that could not be
given shows why in place of its state.

What each provider does with them:

| Provider    | Shared servers                                                                                                                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Takes them at any time. A command server that sets its own folder (`cwd`) runs through `/bin/sh`, which goes into that folder first.                                                                                                                                                                                                      |
| Codex       | Takes them when a session starts. It cannot connect to an SSE server, and cannot replace one of its own of another kind, or with settings the shared one cannot override; that server is off. When Codex does not say which servers it has, the shared ones are off for that session. With the setting Off, its plugins' servers stay on. |
| opencode    | Takes them when a session starts, and cannot connect to an SSE server. The servers it gets, and its own switched off, apply to the whole folder in opencode's running service, your other opencode screens there included, until it restarts or reloads the folder.                                                                       |
| Pi          | Takes them when a session starts, through a small extension YellowCode keeps in `~/.yellowcode/pi-extensions/`. It cannot connect to an SSE server. With the setting On, Pi's own server of the same name wins, and `/mcp` says so.                                                                                                       |

[Subagents](agents.md#subagents) get the shared servers when they keep the provider's own: on Codex and Pi, only with
`plugins: true`.

## Skills on every provider

Each provider loads skills from its own folders, and YellowCode adds nothing to that. Codex, opencode and Pi read
`.agents/skills` in your project and `~/.agents/skills`. Claude Code reads only `.claude/skills` and
`~/.claude/skills`, which opencode reads too. To keep one copy of a skill for all four, put it in `.agents/skills` and
link it for Claude Code:

```sh
mkdir -p .claude/skills
ln -s ../../.agents/skills/my-skill .claude/skills/my-skill
```

For skills you use in every project, link from `~/.agents/skills` to `~/.claude/skills` the same way.

Pi reads a project's `.agents/skills` only in a project you trust. Trust it once in Pi's own screen, or set
`defaultProjectTrust` to `"always"` in `~/.pi/agent/settings.json`; YellowCode does not ask for it. When Pi leaves a
project's skills and `.pi` files off, YellowCode tells you once for that project.

## Files it writes

| Path                                                            | Holds                                                                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/yellowcode/settings.json`                            | Your providers, favorite and hidden models and the model you used last. `settings.json.bak` is the backup of a settings file YellowCode could not read.    |
| `~/.config/yellowcode/state.json`                               | Screen state, such as the sidebar width.                                                                                                                   |
| `~/.config/yellowcode/mcp.json`                                 | Your [shared MCP servers](#shared-mcp-servers). A project's own are in its `.mcp.json`.                                                                    |
| `~/.config/yellowcode/mcp-trust.json`                           | Your yes or no to each project's `.mcp.json`, with a fingerprint of the servers it held then.                                                              |
| `~/.config/yellowcode/themes/`, `mods/`, `mod-data/`, `agents/` | Your themes, mods, mod data and agent files.                                                                                                               |
| `~/.yellowcode/models.json`                                     | The models each provider listed last, with their names, effort levels and context windows.                                                                 |
| `~/.yellowcode/logs/yellowcode.log`                             | The log, or the folder in `YELLOWCODE_LOG_DIR`. `YELLOWCODE_DEBUG=1` adds debug lines, which can contain session text.                                     |
| `~/.yellowcode/sessions/`                                       | One record and one socket for each open session, in a folder only you can read. A session removes its own when it closes.                                  |
| `~/.local/share/yellowcode/snapshots/`                          | Rewind snapshots: copies of files from your projects. Snapshots older than 30 days are deleted; with Claude Code, its `cleanupPeriodDays` is used instead. |
| `~/.yellowcode/pi-prompts/`                                     | One small file per Pi session. Rewind snapshots are filed under a prompt id that Pi does not keep, so YellowCode saves it here.                            |
| `~/.yellowcode/pi-extensions/`                                  | The extension that gives Pi the shared MCP servers. It holds no servers; they reach Pi in an environment variable.                                         |
| `~/.yellowcode/skills/`                                         | YellowCode's own skills: these docs and the Mod API, written again when they change.                                                                       |
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
