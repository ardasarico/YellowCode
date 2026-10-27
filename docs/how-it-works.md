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

## What YellowCode adds to your session

- A short note at the end of the agent's system prompt that says what this screen can draw: local images, mermaid
  diagrams, callouts and a few code blocks of its own. The text is in
  [`src/source/append-prompt.ts`](../src/source/append-prompt.ts).
- Its own question tool in place of Claude Code's `AskUserQuestion`, so questions show in YellowCode's own dialog.
- Permission asks come to YellowCode, and you answer them there.
- Session titles. After each message you send, a separate `claude -p --model=haiku` call names the session. It sends
  your last 12 messages, each cut to 300 characters, and runs with no tools and no saved session. That is one small
  extra request each time. Set Session title to Claude Code in `/settings` to turn it off.
- The `auto` permission mode at start, unless you pick another one in `/settings`.
- Thinking shown as a summary, or hidden if you set Thinking to hidden in `/settings`.
- The tools and MCP servers of the [mods](mods.md) you have turned on.

## What it never does

- Read your credentials or API keys.
- Talk to a model provider itself.
- Send your prompts, files or sessions anywhere but to your agent.

The only requests YellowCode makes on its own are for mods. It fetches the [mod list](mods.md) from GitHub at most once
a day and updates listed mods in the background. When a mod is installed or updated, its code comes from GitHub and its
dependencies, if it has any, from npm. Mods are code you chose to run, so they can do more. See [Mods](mods.md).

## What it keeps on your machine

Settings, logs and rewind snapshots, which are copies of files from your projects. [Usage](usage.md#files-it-writes)
lists where each one lives. For `/resume`, YellowCode reads the session list your agent keeps, such as Claude Code's
`~/.claude/projects`.
