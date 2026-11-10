# Subagents and sessions

Two ways to spread work over more than one agent: subagents, which your session starts and waits on, and other open
sessions, which you or your agent hand work to. Both work across providers.

## Subagents

Your agent can run subagents: sessions of their own, on any provider you added, that work on a task while your session
goes on. Ask for one, for example "have a Codex model write the tests for this". Your agent runs one of your
[agent files](#agent-files), or names a model directly; then you are asked first which model runs, if any.

To name the model, type `@` and part of its name: the models and agents a subagent can run as show above the files,
favorites first. Picking one writes its shortest unique name, such as `@deepseek-v4-flash`, or the provider in front
when two rows share it (`@opencode/openrouter/deepseek-v4-flash`). The message still goes to your agent, which decides
what to run. A model you named this way in your own message runs without the ask.

Claude Code, Codex and opencode sessions get the tools to run subagents. A Pi session gets none, but Pi can run as a
subagent of another session.

- A subagent works in the same folder as your session. Its sessions are not saved and do not show in `/resume`.
- It never gets a wider permission mode than your session's. If its provider has no mode narrower than your session's,
  as with Pi (which asks for nothing), you are asked once in your chat whether it may run. With your session in auto or
  bypass and the agent's permissions on `inherit`, it runs without that ask. An opencode subagent under a session that
  asks runs in build mode and asks you before each edit and shell command.
- Its permission asks and questions show in your chat, marked with its name. They offer no "always" option, so no
  grant outlives the subagent.
- When it finishes, its last message, the files it edited and how long it took come back to your agent as a message.
  It stays open, so your agent can send it more work, until your agent closes it or your session ends.
- At most 6 run at once by default; more wait for a free slot. Subagents at once in `/settings` changes the number,
  from 1 to 10.
- Ctrl+T shows them in the agent panel, where you can follow one. There `m` sends it a message, `x` stops it (in its
  own view) and `c` closes it.

A subagent gets none of your session's own tools: no subagents of its own, no other sessions and no mod tools.

### How a subagent starts

The session you work in gets five tools, given the same way as the mods' tools: `agents` lists the agent files and
providers, `run` starts a subagent, `send` gives it more work, `stop` stops its task and `close` closes it. `run`
returns at once, and the result comes back later as a message, so no provider's tool timeout is hit.

A subagent is a new session of its provider, started in your project folder, with the task as its first message. What
differs by provider:

| Provider    | Instructions                               | Not saved as                     | Your plugins, hooks and MCP servers           |
| ----------- | ------------------------------------------ | -------------------------------- | --------------------------------------------- |
| Claude Code | Added to the system prompt                 | A session without a saved file   | Kept; there is no switch to leave them out    |
| Codex       | Put ahead of the task in the first message | A thread that is not kept        | Left out unless the file says `plugins: true` |
| opencode    | Put ahead of the task in the first message | A session deleted when it closes | Kept; there is no switch to leave them out    |
| Pi          | Put ahead of the task in the first message | A run without a session file     | Left out unless the file says `plugins: true` |

On Codex and Pi, a subagent without `plugins: true` has neither your own MCP servers nor your
[shared ones](usage.md#shared-mcp-servers). On Claude Code and opencode, and with `plugins: true`, it gets the shared
servers, and your own ones as your session has them.

Its permission mode is the widest one its provider has that is no wider than both your session's mode and the agent's
`permissions`. A subagent and your session share the working tree, and rewind snapshots follow your session only, so a
rewind in your session can also undo a subagent's edits.

## Agent files

An agent file is a task description with a model. Three are built in:

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
- `plugins`: `true` starts it with your plugins, hooks and MCP servers, the shared ones included. Without it, it starts
  without them on Codex and Pi. Claude Code and opencode have no switch for this and keep them either way.

The body is the agent's instructions. An agent runs only once it has a model on a provider you added. `/agents` lists
every agent with its model: Enter picks a model, written into the agent's file (for a built-in, into a new file in
`~/.config/yellowcode/agents/`), and `e` opens the file.

## Sessions working together

Every YellowCode session open on your machine can see the others and send them messages, whichever provider each one
runs. Ask your agent to hand something over, for example "give the token tests to the session in ~/work/api", and it
does the rest.

Claude Code, Codex and opencode sessions can list and send. A Pi session gets none of these tools, so it only receives.

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
