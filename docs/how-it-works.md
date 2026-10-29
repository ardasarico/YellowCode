# How it works

YellowCode is a screen for your coding agent. It has no model, tools or login of its own. When you start it in a
project, it starts your agent in the same folder, sends it what you type and draws what comes back. The agent runs on
your own account, with your own settings, MCP servers, skills and plugins.

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
quits. YellowCode never stops or restarts it. It needs opencode 2 or newer and is developed against opencode 2.2.x.

## What YellowCode adds to your session

- With Claude Code, a short note at the end of the agent's system prompt that says what this screen can draw: local
  images, mermaid diagrams, callouts and a few code blocks of its own. The text is in
  [`src/source/append-prompt.ts`](../src/source/append-prompt.ts). Codex and opencode get no such note.
- Its own question tool in place of the agent's, such as Claude Code's `AskUserQuestion`, so questions show in
  YellowCode's own dialog.
- Permission asks come to YellowCode, and you answer them there.
- Session titles. After each message you send, YellowCode asks the agent for a title in a separate request. It sends
  your last 12 messages, each cut to 300 characters. With Claude Code that is a `claude -p --model=haiku` call with no
  tools and no saved session. With Codex it is a short thread that is not saved, can change nothing and has no tools,
  on your model at its lowest effort. With opencode it is opencode's own text generation on its default model, outside
  any session. That is one small extra request each time. Set Session title to your agent's name in `/settings` to turn
  it off.
- With Claude Code, the `auto` permission mode at start. Codex and opencode start in their own default mode. Pick
  another start mode for each agent in `/settings`.
- Thinking shown as a summary, or hidden if you set Thinking to hidden in `/settings`. The setting does not apply to
  opencode.
- The tools of the [mods](mods.md) you have turned on, and with Claude Code and Codex their MCP servers. Codex takes
  them when a session starts, so a change reaches it in the next session.

## What it never does

- Read your credentials or API keys.
- Talk to a model provider itself.
- Send your prompts, files or sessions anywhere but to your agent.

The only requests YellowCode makes on its own are for mods. It fetches the [mod list](mods.md) from GitHub at most once
a day and updates listed mods in the background. When a mod is installed or updated, its code comes from GitHub and its
dependencies, if it has any, from npm. Mods are code you chose to run, so they can do more. See [Mods](mods.md).

## What it keeps on your machine

Settings, logs and rewind snapshots, which are copies of files from your projects. [Usage](usage.md#files-it-writes)
lists where each one lives. For `/resume`, YellowCode reads the session lists your agents keep: Claude Code's
`~/.claude/projects`, and what Codex's app-server and opencode's service list for the project.
