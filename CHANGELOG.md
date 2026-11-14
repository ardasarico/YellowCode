# Changelog

## 0.5.2

### Fixed

- Replies with many images no longer freeze the screen; the chat keeps drawing.
- Install, update and mod commands print clearer output.
- When a turn ends, calls that read images fold into the tool run with the others instead of staying on their own
  rows.

## 0.5.1

### Fixed

- Animated GIFs play in the chat and in the image viewer, where they showed only their first frame.
- When an image in the agent's reply does not show, the agent is told with your next message, so it can fix the
  path.
- An image that does not show says why: not found, too large (over 20 MB) or not a file.

## 0.5.0

### Highlights

- **One memory for every provider.** What the agent learns about your project is kept by YellowCode, so Claude Code,
  Codex, opencode and Pi all read it and it stays when you switch models. `/memory` lists it.
- **A command palette.** Ctrl+P finds every command, model, recent session and setting in one list.
- **A calmer chat.** When a turn is done, its tool calls fold into one line, such as `14 tools · 5 files changed`.
  Enter opens it.

### Breaking

- Providers' plugins are off by default. Turn them on with Providers' plugins in `/settings`. opencode cannot switch
  them off and loads them as before.
- Everything YellowCode keeps now lives in `~/.yellowcode`. Your settings, themes, mods and rewind snapshots move
  there on the first start, and an older version will not find them. `YELLOWCODE_HOME` puts the folder elsewhere.

### Added

- `/settings` opens with an overview of the session: MCP servers, skills, subagents, permissions and memory, each one
  Enter away.
- The Git mod lets you write notes on the lines of a diff and puts them in the prompt for the agent.
- Mods can handle Esc in their own dialogs and use the theme's code and diff colours (Mod API 0.2.2).

### Changed

- `/mcp` opens in its own window, and `/settings` has the tabs Status, Config and Mods.
- `/plugins` is gone, and `/timeline` is no longer listed. Typing `/timeline` still works.

### Fixed

- A resumed Claude Code session keeps the results of tool calls that ran at the same time.
- Images behind an open window no longer stay in their old place or show only half.
- In an opencode session, `/settings` shows the version and the session.

## 0.4.0

### Highlights

- **One MCP list for every provider.** Add an MCP server once with `yellowcode mcp add` and Claude Code, Codex,
  opencode and Pi all get it. `/settings` can turn the providers' own servers off.
- **The agent can read YellowCode's docs.** Every provider gets two built-in skills: these docs, and a guide to
  writing mods.
- **A provider that cannot start no longer stops YellowCode.** It opens the next provider you added and says why.

### Added

- `/mcp` shows the shared servers first, and the reason when one is off.
- The output of `!` commands reaches Codex, opencode and Pi with your next message.
- Images you pasted move with the conversation when you switch to another provider's model.
- Pi takes MCP servers, and its MCP tool calls are labelled in the chat.
- Pi tells you once when it leaves an untrusted project's skills and `.pi` files off.

### Changed

- A project's `.mcp.json` servers start only after you say yes, in Claude Code too. YellowCode asks once for each
  project, and again when the file changes.
- With no provider installed, YellowCode lists how to install each one.
- F4 says when ultracode is not available with the provider in use.

## 0.3.0

### Added

- Paste an image into your answer when the agent asks you a question.
- A question from the agent comes with a short context, shown in the chat above it.

## 0.2.0

### Highlights

- **Mention models and agents.** Type `@` in the prompt to name a model or an agent from any of your providers, and
  your agent hands that part of the work to it.
- **The agent knows YellowCode.** Claude Code, Codex, opencode and Pi are told they run inside YellowCode, so they can
  answer questions about its commands, mods and themes and draw charts, diagrams and images in the chat.
- **Numbers at a glance.** New `stats` and `row` blocks show test results, sizes and short facts as a strip or tiles.

### Added

- Charts use one bar colour and have titles and legends.
- Mods can tell the agent about the blocks they draw.
- A cat word shows while the model thinks.

### Changed

- Long chats scroll smoothly while a reply streams in.
- Updates are checked every hour, and at once when you switch channels.

### Fixed

- Questions from the agent no longer point at a plan or result you have not seen.
- New Claude models show in `/model` even before they get a short name.
- A message sent during a turn stays below the turn until the agent takes it in.
- opencode, Codex and Pi list `/model`, `/effort`, `/context`, `/rename` and `/plan`.
- Commands run on a model you just picked go to that model's provider.
- A background task finishing no longer marks the turn as done.
- Matrix questions have a blank line between their rows.

## 0.1.1

### Fixed

- Claude in Chrome works in YellowCode when you turned it on in Claude Code with `/chrome`.

### Changed

- npm packages are published from GitHub Actions with signed provenance, and their pages have a README.

## 0.1.0

The first release. YellowCode runs Claude Code, Codex, opencode and Pi in one terminal UI, each through its own binary
and your own account.

### Highlights

- **Paste images.** Paste a screenshot or an image file into the prompt and see it before you send.
- **Images and diagrams in the chat.** Mermaid diagrams, charts and images are drawn, not printed as text.
- **Rewind with your files.** Go back to an earlier message and the project goes back too, whoever changed the files.
  `/redo` undoes it.
- **Every model in one picker.** `/model` lists the models of all your providers; pick another provider's and the chat
  moves there.
- **Subagents on any provider.** Hand a task to a Codex model from a Claude Code session and get the answer back.
- **Sessions that work together.** Your open sessions can send each other work, whichever provider each runs.
- **Mods.** Add your own commands, panes, sidebar sections and tools in TypeScript.
