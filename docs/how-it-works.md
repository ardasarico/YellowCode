# How it works

YellowCode is a screen for your coding agent. It has no model and no login of its own. When you start it in a
project, it starts your agent in the same folder, sends it what you type and draws what comes back. The agent runs on
your own account, with your own settings, MCP servers, skills and plugins.

On screen, Claude Code, Codex, opencode and Pi are called providers. A session runs one of them. Subagents can run
others beside it, each through its own binary or service in the same way.

## Claude Code

YellowCode runs `claude -p --input-format=stream-json --output-format=stream-json`, with a few more flags, and talks to
it over that stream. Every request goes through the `claude` binary, signed in as you.

This stream is not a public API. Some of the messages YellowCode relies on are internal to Claude Code and can change in
any release. YellowCode is developed against Claude Code 2.1.x. If something breaks after a Claude Code update,
[open a bug report](https://github.com/ardasarico/YellowCode/issues/new?template=bug.yml).

## Codex

Each session gets its own `codex app-server`, started in the project folder, and YellowCode talks to it over JSON-RPC on
its stdin and stdout. Every request goes through the `codex` binary, signed in as you. YellowCode is developed against
Codex 0.165.x.

## opencode

opencode keeps one local service that its own screens share. YellowCode connects to it the way opencode's TUI does: to
the service that is already running, or else it starts `opencode serve --service`, which keeps running after YellowCode
quits. YellowCode never stops it, and does not start another service while a live one is registered. It needs
opencode 2 or newer and is developed against opencode 2.2.x.

## Pi

Each session gets its own `pi --mode rpc`, started in the project folder, and YellowCode talks to it over JSON lines on
its stdin and stdout. Every request goes through the `pi` binary, with your own models and keys. YellowCode is developed
against pi 1.4.x.

> [!WARNING]
> Pi runs every tool without asking first, file edits and shell commands included, and YellowCode does not add asks of
> its own. The prompt shows `no approvals` while a Pi session runs, and the first Pi session says so once.

> [!WARNING]
> Pi does not lock its session files. Do not open the same session in Pi's own screen and in YellowCode at the same
> time, or both write to it and the file can break.

Pi loads a project's own skills and `.pi` files only in a folder you trust, and over RPC it leaves them off without
saying so. When that happens, YellowCode tells you once for that project; trust it in Pi's own screen.

Pi has no plan mode or subagents of its own, so those screens do not show, and a Pi session gets no tools to run
subagents or to message other sessions. It does take MCP servers: the mods' and the
[shared ones](usage.md#shared-mcp-servers), which `/mcp` lists. Pi can run as another session's subagent and receive
messages. Questions from your Pi extensions open in YellowCode's own dialog, and their notices show as lines in the
chat.

## Models of other providers

`/model` and the subagents need the models of providers that are not running. YellowCode keeps the list each provider
gave last in `~/.yellowcode/models.json`: each model's id, name, effort levels, context window and image support, and
the provider's name, version and when it listed them. Nothing else. The running session fills it. When a provider has
no list there yet, or a new version, YellowCode starts that provider briefly in the background, the same way it starts
a session, and asks for its models. That sends no request to a
model. It happens the first time `/model`, `/agents` or a subagent needs the list, never at start.

A conversation moves to another provider as plain text: a new session starts there, and the text goes ahead of your
next message, marked as earlier context and not a request. Your own newest four images whose bytes YellowCode still
has go with that message. It is cut to fit the new model's context window, which comes from the provider's model list
(opencode and Pi), from Claude Code for each model as the list is made, from Codex's own `~/.codex/models_cache.json`,
or from a turn on that model that YellowCode has seen. A model with none of these cannot take a conversation.

## Subagents

Your session gets tools to run subagents on the providers you added, which Claude Code, Codex and opencode sessions
get and Pi does not. How they start, which providers keep your plugins and how permissions work are in
[Subagents and sessions](agents.md#subagents).

## What YellowCode adds to your session

- A short note added to the agent's own instructions that says it runs in YellowCode and what this screen can draw:
  local images, mermaid diagrams, callouts and a few code blocks of its own. The text is in
  [`src/agent/yellowcode-prompt.ts`](../src/agent/yellowcode-prompt.ts).
- Two skills of YellowCode's, for this session only: `yellowcode-docs`, these docs, which the agent reads when you ask
  about YellowCode, and `yellowcode-mods`, the Mod API and the example mods, for writing a mod. They are written to
  `~/.yellowcode/skills/` and given to each provider its own way:
  - Claude Code gets the folder as a plugin of the session, with `--plugin-dir`, and may read it without asking.
  - Codex gets it as an extra skills folder of its app-server.
  - opencode takes skills folders only in its service's settings, which would reach your own opencode screen too, so
    it gets the skills' names and paths in the session's instructions and reads the files itself.
  - Pi gets it with `--skill`.
- Its own question tool in place of the agent's, such as Claude Code's `AskUserQuestion`, so questions show in
  YellowCode's own dialog. Pi has no question tool, so it gets none.
- Permission asks come to YellowCode, and you answer them there. Pi asks none.
- Session titles. After each message you send, YellowCode asks the agent for a title in a separate request, with your
  last 12 messages, each cut to 300 characters. That is one small extra request each time. Set Session title to your
  agent's name in `/settings` to turn it off. The request for each provider:

  | Provider    | Title request                                                                                             |
  | ----------- | --------------------------------------------------------------------------------------------------------- |
  | Claude Code | `claude -p --model=haiku` with no tools and no saved session                                              |
  | Codex       | A short thread that is not saved, can change nothing and has no tools, on your model at its lowest effort |
  | opencode    | opencode's own text generation on its default model, outside any session                                  |
  | Pi          | `pi --print` on its default model with no tools, extensions, thinking or saved session                    |

- With Claude Code, the `auto` permission mode at start. Codex and opencode start in their own default mode, and Pi has
  only one. Pick another start mode for each agent in `/settings`.
- Thinking shown as a summary, or hidden if you set Thinking to hidden in `/settings`. The setting does not apply to
  opencode or Pi.
- The tool rows of a finished turn folded into one line, three or more in a row, which opens again with Enter or a
  click. Set Finished turns to Show tools in `/settings` to keep every row.
- Three tools for your other open sessions, `list`, `send` and `broadcast`, given to the agent the same way as the mods'
  tools. See [Sessions working together](agents.md#sessions-working-together). Pi does not get them.
- Five tools to run [subagents](agents.md#subagents) on the providers you added. Pi does not get them.
- The tools of the [mods](mods.md) you have turned on, and their MCP servers. Codex takes the tools when a session
  starts, so a change reaches it in the next session. Pi takes no tools from YellowCode. Codex, opencode and Pi take
  the mods' MCP servers when a session starts.
- The [shared MCP servers](usage.md#shared-mcp-servers), with each provider's own:
  - Claude Code gets them as servers set for the session over its stream, the same way as the mods'. Claude Code
    reads every `.mcp.json` from the folder up to `/` by itself, so whenever there is one, trusted or not, it is told
    to leave off every server those files name, by name and with no file written. With Providers' own MCP servers
    Off, it starts with `--strict-mcp-config`.
  - Codex gets them as config overrides of the thread it starts. A shared server of the same name as one of Codex's
    own overrides each of the own one's fields. Of the own one, YellowCode keeps only the names of its fields and what
    program or URL it runs. Off switches Codex's own off the same way.
  - opencode gets them added to its running service for the folder, and Off disconnects its own there. Nothing is
    written to disk. When the session closes, YellowCode takes back what no other session of it in the folder still
    needs.
  - Pi gets them through a small extension of YellowCode's, loaded with `-e`, which reads them from an environment
    variable of Pi's process. With Off, on Pi 1.4 and later, Pi starts with `--no-mcp`, and the extension stands in
    for Pi's own MCP extension, with none of Pi's own servers.
- The output of your `!` shell commands, with your next message. Claude Code also reads it at once when it is idle.

## What it never does

- Read your credentials or API keys. The values in a shared MCP server's `${VAR}` come from YellowCode's own
  environment and go only to the provider that runs the server.
- Write your providers' files. With opencode, it does switch servers on and off inside opencode's running service for
  the folder, which your other opencode screens there see, until the service restarts or reloads the folder.
- Talk to a model provider itself.
- Send your prompts, files or sessions anywhere but to your agent. When your agent messages another open session, the
  message goes to that session on your machine and nowhere else. A moved conversation or a subagent's task goes only
  to a provider you added.

The only requests YellowCode makes on its own are for updates and mods. It reads `release/channels.json` from the repo
on GitHub when it starts, if the last check was 20 hours ago or more, and every 20 hours after, and downloads a new
version from GitHub, or runs your package manager, which downloads it from npm. `YELLOWCODE_DISABLE_AUTOUPDATE=1` turns
off this update check only. YellowCode also fetches the [mod list](mods.md) from GitHub at most once a day and updates
listed mods in the background. When a mod is installed or updated, its code comes from GitHub and its dependencies, if
it has any, from npm. Mods are code you chose to run, so they can do more. See [Mods](mods.md).

## What it keeps on your machine

Settings, your shared MCP servers and your answers about each project's, the model lists, logs and rewind snapshots,
which are copies of files from your projects.
[Usage](usage.md#files-it-writes) lists where each one lives. For `/resume`, YellowCode reads the session lists your
providers keep: Claude Code's `~/.claude/projects`, what Codex's app-server and opencode's service list for the project,
and Pi's session files in `~/.pi/agent/sessions`.
